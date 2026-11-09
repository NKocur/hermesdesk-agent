#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  VERSION,
  configHome,
  loadConfig,
  saveConfig,
  validateConfig,
  projectSessionDir,
} from "../src/config.js";
import {
  getCredential,
  saveCredential,
  hiddenInput,
  logout,
} from "../src/credentials.js";
import { discover } from "../src/transport.js";
const help = `HermesDesk Agent ${VERSION} (Pi-based, Windows first)

  hermesdesk connect [--url https://your-server.example/v1]
  hermesdesk doctor
  hermesdesk chat [--cwd PATH] [--continue | --session ID] [--read-only]
  hermesdesk run "REQUEST" [--cwd PATH] [--json] [--read-only]
  hermesdesk sessions [--cwd PATH]
  hermesdesk config [set KEY VALUE]
  hermesdesk logout

Edits and shell commands ask for approval in interactive chat.
One-shot runs deny changes by default; --approve-writes permits workspace file edits.
Shell commands always require interactive approval. This is not an OS sandbox.
Settings: model, context, maxTokens, thinking, temperature, topP, topK, maxRequests.
`;
async function main() {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
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
  const command = p.shift() || "chat",
    home = configHome();
  process.env.PI_CODING_AGENT_DIR = path.join(home, "pi");
  let config = loadConfig(home);
  if (command === "connect") {
    if (v.url) config = validateConfig({ ...config, baseUrl: v.url });
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (!v.url && process.stdin.isTTY) {
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
    const token =
      process.env.HERMESDESK_API_KEY ||
      (await hiddenInput("HermesDesk API key (hidden): "));
    const models = await discover(config, token);
    if (!models.length) throw Error("No models are available.");
    if (!models.includes(config.model)) config.model = models[0];
    await saveCredential(home, config.baseUrl, token);
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
    if (p[0] === "set") {
      const key = p[1];
      if (!Object.hasOwn(config, key) || key === "baseUrl")
        throw Error(
          "Choose a supported setting; use connect --url to change servers.",
        );
      const raw = p.slice(2).join(" ");
      if (!raw) throw Error("Provide a setting value.");
      let value = raw;
      if (key !== "model") {
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
    console.log(
      selected.length
        ? selected
            .map(
              (r) =>
                r.id +
                "  " +
                (r.name || r.firstMessage || "Untitled")
                  .replace(/\s+/g, " ")
                  .slice(0, 90),
            )
            .join("\n")
        : "No saved sessions for this project.",
    );
    return;
  }
  if (!["doctor", "chat", "run"].includes(command))
    throw Error("Unknown command. Use hermesdesk --help.");
  if (!config.baseUrl || !config.model)
    throw Error("Not connected. Run hermesdesk connect first.");
  const token = await getCredential(home, config.baseUrl);
  delete process.env.HERMESDESK_API_KEY;
  if (command === "doctor") {
    const models = await discover(config, token);
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
  const cwd = fs.realpathSync.native(v.cwd || process.cwd());
  if (command === "chat" && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw Error(
      'Interactive chat needs a terminal. Use hermesdesk run "request" for one-shot operation.',
    );
  if (command === "run" && !p.length)
    throw Error('Provide a request: hermesdesk run "Inspect this project".');
  const { createRuntime, runPrompt } = await import("../src/agent.js");
  const runtime = await createRuntime({
    config,
    home,
    token,
    cwd,
    readOnly: !!v["read-only"],
    approveWrites: !!v["approve-writes"],
    continueSession: !!v.continue,
    sessionId: v.session,
  });
  const cancel = () => {
    void runtime.session.abort();
  };
  process.on("SIGINT", cancel);
  try {
    if (command === "run") {
      await runPrompt(runtime, p.join(" "), { json: !!v.json });
    } else {
      const { InteractiveMode } = await import(
        "@earendil-works/pi-coding-agent"
      );
      const ui = new InteractiveMode(runtime, {
        verbose: false,
        initialMessage: p.length ? p.join(" ") : undefined,
      });
      await ui.run();
    }
  } finally {
    process.off("SIGINT", cancel);
    await runtime.dispose();
  }
}
main().catch((e) => {
  let message = e.message || "Operation failed.";
  for (const secret of [process.env.HERMESDESK_API_KEY])
    if (secret) message = message.split(secret).join("[redacted]");
  if (/<!doctype|<html/i.test(message))
    message =
      "Cloudflare rejected the API request. Run hermesdesk doctor to check the connection.";
  console.error("HermesDesk: " + message.slice(0, 1200));
  process.exitCode = 1;
});
