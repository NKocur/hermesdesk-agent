import fs from "node:fs";
import path from "node:path";
import { projectSessionDir } from "./config.js";
import { searchTool } from "./search.js";
import { modelFetch } from "./transport.js";
import { policyExtension, workspacePath } from "./policy.js";
export async function createRuntime({
  config,
  home,
  token,
  access,
  cwd = process.cwd(),
  readOnly = false,
  approveWrites = false,
  continueSession = false,
  sessionId,
}) {
  const agentDir = path.join(home, "pi");
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const {
    ModelRuntime,
    SettingsManager,
    SessionManager,
    createAgentSessionServices,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
  } = await import("@earendil-works/pi-coding-agent");
  const { streamSimple } = await import(
    "@earendil-works/pi-ai/api/openai-completions"
  );
  cwd = fs.realpathSync.native(cwd);
  if (!fs.statSync(cwd).isDirectory())
    throw Error("Choose an existing project directory.");
  const sessionDir = projectSessionDir(home, cwd);
  fs.mkdirSync(sessionDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const safeFetch = modelFetch(config.baseUrl, access);
  let requestCount = 0;
  modelRuntime.registerProvider("hermesdesk", {
    name: "HermesDesk / Strata",
    baseUrl: config.baseUrl,
    api: "openai-completions",
    apiKey: token,
    headers: { "User-Agent": "HermesDesk-CLI/1.0" },
    models: [
      {
        id: config.model,
        name: config.model,
        input: ["text"],
        reasoning: config.thinking,
        contextWindow: config.context,
        maxTokens: config.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: false,
          supportsStore: false,
          maxTokensField: "max_tokens",
          supportsReasoningEffort: false,
        },
      },
    ],
    streamSimple: (model, context, options) => {
      if (++requestCount > config.maxRequests)
        throw Error(
          "Request budget reached. Send another message to continue.",
        );
      return streamSimple(model, context, {
        ...options,
        fetch: safeFetch,
        maxRetries: 0,
        timeoutMs: 1800000,
        maxTokens: config.maxTokens,
        onPayload: async (payload, m) => {
          const p = (await options?.onPayload?.(payload, m)) ?? payload;
          delete p.store;
          delete p.reasoning_effort;
          p.max_tokens = config.maxTokens;
          p.temperature = config.temperature;
          p.top_p = config.topP;
          p.top_k = config.topK;
          p.chat_template_kwargs = { enable_thinking: config.thinking };
          return p;
        },
      });
    },
  });
  const model = modelRuntime.getModel("hermesdesk", config.model);
  if (!model) throw Error("The configured model could not be registered.");
  const factory = async ({
    cwd: target,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const settingsManager = SettingsManager.inMemory({
      enableAnalytics: false,
      enableInstallTelemetry: false,
      packages: [],
      cacheWarming: "off",
      retry: { enabled: false },
      providerRetry: { maxRetries: 0, timeoutMs: 1800000 },
      compaction: {
        enabled: true,
        reserveTokens: Math.min(16384, Math.floor(config.context / 4)),
        keepRecentTokens: Math.min(12000, Math.floor(config.context / 4)),
      },
    });
    const instructions = [];
    try {
      const file = workspacePath(target, "AGENTS.md");
      if (fs.existsSync(file) && fs.statSync(file).size <= 65536)
        instructions.push(
          "Workspace AGENTS.md:\n" + fs.readFileSync(file, "utf8"),
        );
    } catch {}
    const services = await createAgentSessionServices({
      cwd: target,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        appendSystemPrompt: [
          "You are HermesDesk Agent, a coding assistant powered by a locally hosted model. Inspect before editing, preserve unrelated work, verify changes with appropriate checks, and report results honestly. File tools are restricted to the selected workspace; never bypass a declined action. Shell commands require approval and are not OS-sandboxed.",
          ...instructions,
        ],
        extensionFactories: [
          policyExtension({
            root: target,
            readOnly,
            approveWrites,
            maxRequests: config.maxRequests,
            onAgentStart: () => {
              requestCount = 0;
            },
          }),
        ],
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      thinkingLevel: config.thinking ? "medium" : "off",
      customTools: [searchTool(target)],
      tools: readOnly
        ? ["read", "ls", "search"]
        : [
            "read",
            "ls",
            "search",
            "edit",
            "write",
            process.platform === "win32" ? "powershell" : "bash",
          ],
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  let sessionManager = continueSession
    ? SessionManager.continueRecent(cwd, sessionDir)
    : SessionManager.create(cwd, sessionDir);
  if (sessionId) {
    if (!/^[a-f0-9-]{8,36}$/i.test(sessionId))
      throw Error("Use a session ID from hermesdesk sessions.");
    const file = SessionManager.findById(cwd, sessionId, sessionDir);
    if (!file) throw Error("Session not found in this project.");
    sessionManager = SessionManager.open(file, sessionDir, cwd);
  }
  return createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager });
}
export async function runPrompt(
  runtime,
  prompt,
  { json = false, out = process.stdout } = {},
) {
  let failed = false;
  const off = runtime.session.subscribe((e) => {
    if (
      e.type === "message_update" &&
      e.assistantMessageEvent?.type === "text_delta"
    ) {
      if (json)
        out.write(
          JSON.stringify({
            type: "text",
            text: e.assistantMessageEvent.delta,
          }) + "\n",
        );
      else out.write(e.assistantMessageEvent.delta);
    }
    if (e.type === "tool_execution_start") {
      const row = { type: "tool", name: e.toolName };
      if (json) out.write(JSON.stringify(row) + "\n");
      else process.stderr.write("\n[" + e.toolName + "]\n");
    }
    if (
      e.type === "message_end" &&
      e.message?.role === "assistant" &&
      ["error", "aborted"].includes(e.message.stopReason)
    ) {
      failed = true;
      const detail = e.message.errorMessage || e.message.stopReason;
      process.stderr.write(
        "\n" +
          (/<!doctype|<html/i.test(detail)
            ? "Cloudflare rejected the API request. Check the connection with hermesdesk doctor."
            : detail.slice(0, 1200)) +
          "\n",
      );
    }
  });
  try {
    await runtime.session.bindExtensions({});
    await runtime.session.prompt(prompt);
    if (json)
      out.write(
        JSON.stringify({
          type: "done",
          ok: !failed,
          session: runtime.session.sessionManager.getSessionId(),
        }) + "\n",
      );
    else out.write("\n");
    if (failed) throw Error("The model request did not complete.");
  } finally {
    off();
  }
}
