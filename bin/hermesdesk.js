#!/usr/bin/env node
import fs from "node:fs";
import { profile } from "../src/generation.js";
import {
  invalid,
  outputFormat,
  positiveInteger,
  readPrompt,
  runHeadless,
} from "../src/headless.js";
const rawArgs = process.argv.slice(2);
let requestedOutput =
  rawArgs.includes("--json") ||
  rawArgs[0] === "headless" ||
  rawArgs.includes("--output-format=jsonl") ||
  rawArgs[rawArgs.indexOf("--output-format") + 1] === "jsonl"
    ? "jsonl"
    : rawArgs.includes("--output-format=json") ||
        rawArgs[rawArgs.indexOf("--output-format") + 1] === "json"
      ? "json"
      : "text";
const sanitize = (value) => {
  const redact = (text) => {
    for (const secret of [
      ...privateValues,
      process.env.HERMESDESK_API_KEY,
      process.env.HERMESDESK_ACCESS_CLIENT_SECRET,
      process.env.HERMESDESK_CONNECTION_CODE,
    ])
      if (secret) text = text.split(secret).join("[redacted]");
    return text;
  };
  return typeof value === "string"
    ? redact(value)
    : JSON.parse(
        JSON.stringify(value, (_key, item) =>
          typeof item === "string" ? redact(item) : item,
        ),
      );
};
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  VERSION,
  supportedNode,
  configHome,
  loadConfig,
  saveConfig,
  validateConfig,
  projectSessionDir,
} from "../src/config.js";
import {
  getConnection,
  saveCredential,
  hiddenInput,
  logout,
} from "../src/credentials.js";
import { browserLogin } from "../src/browser-login.js";
import { parseConnectionCode, validateAccess } from "../src/connection.js";
const privateValues = new Set();
const protect = (value) => {
  if (value) privateValues.add(value);
  return value;
};
const clearAuthEnv = () => {
  for (const key of [
    "HERMESDESK_API_KEY",
    "HERMESDESK_ACCESS_CLIENT_ID",
    "HERMESDESK_ACCESS_CLIENT_SECRET",
    "HERMESDESK_CONNECTION_CODE",
  ])
    delete process.env[key];
};
import { discover } from "../src/transport.js";
const help = `HermesDesk Agent ${VERSION} (Pi-based, Windows first)

  hermesdesk connect [--code | --url https://your-server.example/v1] [--manual | --cloudflare-access]
  hermesdesk doctor
  hermesdesk chat [--cwd PATH] [--continue | --session ID] [--read-only]
  hermesdesk run "REQUEST" [--cwd PATH] [--output-format text|json|jsonl] [--read-only]
  hermesdesk run --prompt-file PATH | --stdin [--timeout SECONDS]
  hermesdesk headless [--cwd PATH] [--continue | --session ID]
  hermesdesk sessions [--cwd PATH]
  hermesdesk config [set KEY VALUE | preset fast|balanced|extended]
  hermesdesk logout

Interactive chat asks before edits and commands by default.
/permissions fuck-it enables Fuck it Mode; /permissions ask restores approval prompts.
One-shot runs deny changes by default; --approve-writes permits workspace file edits.
Headless commands are denied unless --approve-commands explicitly permits them.
--read-only overrides both pre-approvals. Shell commands are not OS-sandboxed.
headless accepts JSON lines on stdin: prompt, abort, get_state, shutdown.
Exit codes: 0 complete, 1 failure, 2 invalid input, 3 blocked, 4 output limit,
            124 timed out, 130 cancelled, 143 terminated.
Settings: model, context, maxTokens (total thinking + answer), thinking,
reasoningEffort (low|medium|xhigh), thinkingBudget (0=automatic), temperature, topP, topK, maxRequests.
Run overrides: --profile fast|balanced|extended --max-tokens N --thinking on|off
               --reasoning-effort low|medium|xhigh --thinking-budget N --max-requests N
`;
async function main() {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      "max-tokens": { type: "string" },
      "max-requests": { type: "string" },
      "prompt-file": { type: "string" },
      stdin: { type: "boolean" },
      timeout: { type: "string" },
      "output-format": { type: "string" },
      "approve-commands": { type: "boolean" },
      thinking: { type: "string" },
      "reasoning-effort": { type: "string" },
      "thinking-budget": { type: "string" },
      url: { type: "string" },
      code: { type: "boolean" },
      manual: { type: "boolean" },
      "no-browser": { type: "boolean" },
      "cloudflare-access": { type: "boolean" },
      cwd: { type: "string" },
      session: { type: "string" },
      continue: { type: "boolean" },
      "read-only": { type: "boolean" },
      "approve-writes": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  if (v.help) {
    console.log(help);
    return;
  }
  if (v.version) {
    console.log(VERSION);
    return;
  }
  if (!supportedNode())
    throw Error(
      "Node.js " +
        process.versions.node +
        " is too old. Install Node.js 24 (minimum supported: 22.19.0), close this terminal and open a new one, then run node --version before trying again.",
    );
  const command = p.shift() || "chat",
    home = configHome();
  process.env.PI_CODING_AGENT_DIR = path.join(home, "pi");
  requestedOutput =
    command === "headless"
      ? "jsonl"
      : v["output-format"] === "json"
        ? "json"
        : v.json || v["output-format"] === "jsonl"
          ? "jsonl"
          : "text";
  if (v.continue && v.session)
    throw invalid("Choose --continue or --session ID, not both.");
  const format = outputFormat(v["output-format"], v.json);
  const timeout =
    v.timeout === undefined ? 0 : positiveInteger(v.timeout, "--timeout");
  if (
    command === "chat" &&
    [
      v["approve-commands"],
      v.timeout,
      v["prompt-file"],
      v.stdin,
      v["output-format"],
      v.json,
    ].some((x) => x !== undefined && x !== false)
  )
    throw invalid(
      "Headless I/O and command pre-approval options apply only to run or headless.",
    );
  if (
    command === "headless" &&
    (p.length ||
      v.stdin ||
      v["prompt-file"] ||
      (v["output-format"] && format !== "jsonl"))
  )
    throw invalid(
      "headless accepts JSON lines on stdin, without a positional request or prompt file; output is JSONL.",
    );
  const prompt =
    command === "run"
      ? await readPrompt({
          args: p,
          promptFile: v["prompt-file"],
          stdin: v.stdin,
        })
      : undefined;
  let config = loadConfig(home);
  if (command === "connect") {
    let imported;
    if (v.code || process.env.HERMESDESK_CONNECTION_CODE) {
      if (v.url || v["cloudflare-access"])
        throw Error(
          "Use --code on its own; the private code includes the endpoint and credentials.",
        );
      imported = parseConnectionCode(
        protect(
          process.env.HERMESDESK_CONNECTION_CODE ||
            (await hiddenInput(
              "Private HermesDesk connection code (hidden): ",
            )),
        ),
      );
      config = validateConfig({ ...config, baseUrl: imported.baseUrl });
      console.log("Connecting to " + config.baseUrl);
    }
    if (v.url) config = validateConfig({ ...config, baseUrl: v.url });
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (!imported && !v.url && process.stdin.isTTY) {
      const answer = await rl.question(
        config.baseUrl
          ? "Server [" + config.baseUrl + "]: "
          : "HermesDesk server URL (https://.../v1): ",
      );
      if (answer.trim())
        config = validateConfig({ ...config, baseUrl: answer.trim() });
    }
    rl.close();
    if (!config.baseUrl)
      throw Error(
        "Enter your server URL, or use hermesdesk connect --url https://your-server.example/v1.",
      );
    if (
      !imported &&
      !v.manual &&
      !v["cloudflare-access"] &&
      !process.env.HERMESDESK_API_KEY &&
      !process.env.HERMESDESK_ACCESS_CLIENT_ID
    ) {
      imported = await browserLogin(config.baseUrl, {
        launch: v["no-browser"] ? async () => {} : undefined,
      });
    }
    const token = protect(
      imported?.token ||
        process.env.HERMESDESK_API_KEY ||
        (await hiddenInput("HermesDesk API key (hidden): ")),
    );
    let access = imported?.access;
    if (
      !access &&
      (v["cloudflare-access"] ||
        process.env.HERMESDESK_ACCESS_CLIENT_ID ||
        process.env.HERMESDESK_ACCESS_CLIENT_SECRET)
    ) {
      access = validateAccess({
        clientId:
          process.env.HERMESDESK_ACCESS_CLIENT_ID ||
          (await hiddenInput("Cloudflare Access client ID (hidden): ")),
        clientSecret:
          process.env.HERMESDESK_ACCESS_CLIENT_SECRET ||
          (await hiddenInput("Cloudflare Access client secret (hidden): ")),
      });
    }
    protect(access?.clientSecret);
    clearAuthEnv();
    const models = await discover(config, token, access);
    if (!models.length) throw Error("No models are available.");
    if (!models.includes(config.model)) config.model = models[0];
    await saveCredential(home, config.baseUrl, token, access);
    saveConfig(config, home);
    console.log(
      "Connected. Credential protected for your Windows account.\nModel: " +
        config.model +
        "\nRun hermesdesk chat from your project directory.",
    );
    return;
  }
  if (command === "logout") {
    logout(home);
    console.log(
      "Saved credential removed. Any HERMESDESK_API_KEY environment variable still applies until cleared.",
    );
    return;
  }
  if (command === "config") {
    if (p[0] === "preset") {
      config = saveConfig({ ...config, ...profile(p[1]) }, home);
    } else if (p[0] === "set") {
      const key = p[1];
      if (!Object.hasOwn(config, key) || key === "baseUrl")
        throw Error(
          "Choose a supported setting; use connect --url to change servers.",
        );
      const raw = p.slice(2).join(" ");
      if (!raw) throw Error("Provide a setting value.");
      let value = raw;
      if (!["model", "reasoningEffort"].includes(key)) {
        try {
          value = JSON.parse(raw);
        } catch {
          throw Error("Use a number or true/false for this setting.");
        }
      }
      config = saveConfig({ ...config, [key]: value }, home);
    }
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (command === "sessions") {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const cwd = fs.realpathSync.native(v.cwd || process.cwd());
    const rows = await SessionManager.list(cwd, projectSessionDir(home, cwd));
    const selected = rows.filter(
      (r) => r.cwd.toLowerCase() === cwd.toLowerCase(),
    );
    const data = selected.map((r) => ({
      id: r.id,
      title: (r.name || r.firstMessage || "Untitled")
        .replace(/\s+/g, " ")
        .slice(0, 90),
      cwd: r.cwd,
    }));
    if (format === "json") console.log(JSON.stringify(data));
    else if (format === "jsonl")
      for (const row of data)
        console.log(JSON.stringify({ type: "session", ...row }));
    else
      console.log(
        data.length
          ? data.map((r) => r.id + "  " + r.title).join("\n")
          : "No saved sessions for this project.",
      );
    return;
  }
  if (!["doctor", "chat", "run", "headless"].includes(command))
    throw Error("Unknown command. Use hermesdesk --help.");
  if (!config.baseUrl || !config.model)
    throw Error("Not connected. Run hermesdesk connect first.");
  const { token, access } = await getConnection(home, config.baseUrl);
  protect(token);
  protect(access?.clientSecret);
  clearAuthEnv();
  if (command === "doctor") {
    const models = await discover(config, token, access);
    console.log(
      JSON.stringify(
        {
          connected: true,
          endpoint: config.baseUrl,
          model: config.model,
          available: models.includes(config.model),
          models,
          settingsDirectory: home,
          node: process.version,
          platform: process.platform,
        },
        null,
        2,
      ),
    );
    if (!models.includes(config.model)) process.exitCode = 1;
    return;
  }
  const overrides = {};
  if (v["max-requests"] !== undefined)
    overrides.maxRequests = positiveInteger(
      v["max-requests"],
      "--max-requests",
      512,
    );
  if (v.profile) Object.assign(overrides, profile(v.profile));
  if (v["max-tokens"] !== undefined)
    overrides.maxTokens = Number(v["max-tokens"]);
  if (v["thinking-budget"] !== undefined)
    overrides.thinkingBudget = Number(v["thinking-budget"]);
  if (v["reasoning-effort"] !== undefined)
    overrides.reasoningEffort = v["reasoning-effort"];
  if (v.thinking !== undefined) {
    if (!["on", "off"].includes(v.thinking))
      throw Error("Use --thinking on or --thinking off.");
    overrides.thinking = v.thinking === "on";
  }
  config = validateConfig({ ...config, ...overrides });
  const cwd = fs.realpathSync.native(v.cwd || process.cwd());
  if (command === "chat" && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw Error(
      'Interactive chat needs a terminal. Use hermesdesk run "request" for one-shot operation.',
    );
  const denials = [];
  const { createRuntime } = await import("../src/agent.js");
  const runtime = await createRuntime({
    config,
    home,
    token,
    access,
    cwd,
    readOnly: !!v["read-only"],
    approveWrites: !!v["approve-writes"],
    approveCommands: !!v["approve-commands"],
    onPolicyBlock: (event) => denials.push(event),
    continueSession: !!v.continue,
    sessionId: v.session,
  });
  const controller = new AbortController();
  const cancel = () => {
    controller.abort({ status: "cancelled" });
    void runtime.session.abort();
  };
  const terminate = () => {
    controller.abort({ status: "terminated" });
    void runtime.session.abort();
  };
  const brokenOutput = (error) => {
    if (error.code === "EPIPE") {
      controller.abort();
      process.exitCode = 1;
    } else {
      controller.abort();
      process.stderr.write("HermesDesk: Output stream failed.\n");
      process.exitCode = 1;
    }
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", terminate);
  process.stdout.on("error", brokenOutput);
  try {
    if (command === "run") {
      const result = await runHeadless(runtime, prompt, {
        format,
        timeout,
        denials,
        signal: controller.signal,
        sanitize,
      });
      process.exitCode = result.exitCode;
    } else if (command === "headless") {
      const { serveHeadless } = await import("../src/headless-rpc.js");
      const result = await serveHeadless(runtime, {
        timeout,
        denials,
        signal: controller.signal,
        sanitize,
        permissions: {
          readOnly: !!v["read-only"],
          approveWrites: !!v["approve-writes"] && !v["read-only"],
          approveCommands: !!v["approve-commands"] && !v["read-only"],
        },
      });
      process.exitCode = result?.exitCode || 0;
      if (controller.signal.aborted)
        process.exitCode =
          controller.signal.reason?.status === "terminated" ? 143 : 130;
    } else {
      const { createInteractiveMode } = await import(
        "../src/ui/interactive.js"
      );
      const ui = await createInteractiveMode(runtime, {
        initialMessage: p.length ? p.join(" ") : undefined,
      });
      await ui.run();
    }
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", terminate);
    await runtime.dispose();
    // Leave the output error listener installed until buffered stdout is flushed at exit.
  }
}
main().catch((e) => {
  let message = sanitize(e.message || "Operation failed.");
  if (/<!doctype|<html/i.test(message))
    message =
      "Cloudflare rejected the API request. Run hermesdesk doctor to check the connection.";
  const exitCode = e.exitCode || (e.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1);
  if (requestedOutput !== "text")
    process.stdout.write(
      JSON.stringify({
        type: "done",
        version: VERSION,
        ok: false,
        status: exitCode === 2 ? "invalid" : "failed",
        exitCode,
        session: null,
        error: message.slice(0, 1200),
      }) + "\n",
    );
  else console.error("HermesDesk: " + message.slice(0, 1200));
  process.exitCode = exitCode;
});
