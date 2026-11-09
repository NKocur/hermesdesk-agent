import fs from "node:fs";
import { generationPayload } from "./generation.js";
import { generationCommands } from "./commands.js";
import path from "node:path";
import { VERSION, projectSessionDir, validateConfig } from "./config.js";
import { searchTool } from "./search.js";
import { discover, modelFetch } from "./transport.js";
import { policyExtension, workspacePath } from "./policy.js";
import { THEME_DIR, interfaceExtension, themeSetting } from "./ui/extension.js";
import { friendlyError } from "./ui/format.js";

// Written for locally hosted models: short, concrete rules work better than general advice.
const SYSTEM_PROMPT = [
  "You are HermesDesk Agent, a coding assistant powered by a locally hosted model. Inspect before editing, preserve unrelated work, verify changes with appropriate checks, and report results honestly. File tools are restricted to the selected workspace; never bypass a declined action. Shell commands require approval and are not OS-sandboxed.",
  "Working rules:",
  "- Paths are relative to the workspace. Use search or ls to find code; do not guess file names.",
  "- Read a file before editing it. Copy each oldText exactly from what you read, including indentation, and keep it short and unique.",
  "- Use edit to change an existing file. Use write only for a new file or a full rewrite.",
  "- Take one step at a time and check each tool result before the next step. If a call fails, read the error and change the call; never repeat an identical call.",
  process.platform === "win32"
    ? "- The shell is Windows PowerShell, not bash. Use PowerShell syntax and cmdlets."
    : "- The shell is bash.",
  "- When the task is done, reply with a short summary of what changed and how it was checked. Do not paste whole files into the reply.",
].join("\n");
export async function createRuntime({
  config,
  home,
  token,
  access,
  cwd = process.cwd(),
  readOnly = false,
  approveWrites = false,
  approveCommands = false,
  onPolicyBlock = () => {},
  continueSession = false,
  sessionId,
}) {
  config = validateConfig({ ...config });
  let activeSession;
  const syncThinking = () => {
    if (activeSession) {
      const level = activeSession.thinkingLevel;
      config.thinking = level !== "off";
      if (config.thinking)
        config.reasoningEffort =
          level === "low" || level === "minimal"
            ? "low"
            : level === "medium"
              ? "medium"
              : "xhigh";
    }
    return { ...config };
  };
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
        reasoning: true,
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
      syncThinking();
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
          Object.assign(p, generationPayload(config));
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
      // HermesDesk draws its own header; skip Pi's resource listing at startup.
      quietStartup: "header",
      theme: themeSetting(),
      retry: { enabled: false },
      providerRetry: { maxRetries: 0, timeoutMs: 1800000 },
      compaction: {
        enabled: true,
        reserveTokens: Math.min(
          config.context - 1024,
          Math.max(config.maxTokens + 2048, 16384),
        ),
        keepRecentTokens: Math.min(12000, Math.floor(config.context / 4)),
      },
    });
    const instructions = [];
    if (approveWrites || approveCommands)
      instructions.push(
        "For this launch, the user explicitly pre-approved: " +
          [
            approveWrites && "workspace file edits",
            approveCommands && "shell commands",
          ]
            .filter(Boolean)
            .join(" and ") +
          ". Read-only mode and protected file rules still apply.",
      );
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
        additionalThemePaths: [THEME_DIR],
        noContextFiles: true,
        appendSystemPrompt: [SYSTEM_PROMPT, ...instructions],
        extensionFactories: [
          generationCommands({
            home,
            read: syncThinking,
            apply: async (next) => {
              if (!activeSession || !activeSession.isIdle)
                throw Error("Wait for the agent to become idle.");
              const current = activeSession.model;
              if (
                !current ||
                current.provider !== "hermesdesk" ||
                current.id !== config.model
              )
                throw Error(
                  "Select the connected HermesDesk model before changing generation settings.",
                );
              await activeSession.setModel({
                ...current,
                maxTokens: next.maxTokens,
                reasoning: true,
              });
              Object.assign(config, next);
              settingsManager.applyOverrides({
                compaction: {
                  ...settingsManager.getSettings().compaction,
                  reserveTokens: Math.min(
                    config.context - 1024,
                    Math.max(config.maxTokens + 2048, 16384),
                  ),
                },
              });
              activeSession.setThinkingLevel(
                next.thinking
                  ? next.reasoningEffort === "xhigh"
                    ? "high"
                    : next.reasoningEffort
                  : "off",
              );
            },
          }),
          policyExtension({
            root: target,
            readOnly,
            approveWrites,
            approveCommands,
            onPolicyBlock,
            maxRequests: config.maxRequests,
            onAgentStart: () => {
              requestCount = 0;
            },
          }),
          interfaceExtension({
            version: VERSION,
            readOnly,
            approveWrites,
            read: syncThinking,
            discover: () => discover(config, token, access),
          }),
        ],
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      thinkingLevel: config.thinking
        ? config.reasoningEffort === "xhigh"
          ? "high"
          : config.reasoningEffort
        : "off",
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
    activeSession = result.session;
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
      process.stderr.write("\n" + friendlyError(detail) + "\n");
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
