import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createPermissions, permissionsCommands } from "../src/permissions.js";
import { policyExtension } from "../src/policy.js";
import { createRuntime } from "../src/agent.js";
import { validateConfig } from "../src/config.js";
import { footerFactory, headerFactory } from "../src/ui/chrome.js";

function commands(initial = {}) {
  const permissions = createPermissions(initial),
    notices = [],
    choices = [],
    registered = new Map();
  let busy = false,
    applyCount = 0;
  const ctx = {
    hasUI: true,
    mode: "tui",
    isIdle: () => !busy,
    ui: {
      notify: (text, type) => notices.push({ text, type }),
      select: async () => choices.shift(),
    },
  };
  permissionsCommands({
    permissions,
    apply: (mode) => {
      permissions.change(mode);
      applyCount++;
    },
  })({ registerCommand: (name, command) => registered.set(name, command) });
  return {
    permissions,
    notices,
    choices,
    ctx,
    command: registered.get("permissions"),
    count: () => applyCount,
    busy: (value) => (busy = value),
    run: (args = "") => registered.get("permissions").handler(args, ctx),
  };
}

test("/permissions switches live modes and exposes a menu/current status", async () => {
  const f = commands(),
    display = f.permissions.display;
  await f.run("edits");
  assert.equal(f.permissions.read().approveWrites, true);
  assert.equal(f.permissions.read().approveCommands, false);
  assert.equal(f.permissions.display, display);
  assert.equal(display.short, "edits auto-approved");
  await f.run("read-only");
  assert.equal(f.permissions.read().readOnly, true);
  assert.equal(display.short, "read-only");
  await f.run("ask");
  assert.deepEqual(f.permissions.read(), {
    readOnly: false,
    approveWrites: false,
    approveCommands: false,
  });
  const count = f.count();
  await f.run("show");
  assert.equal(f.count(), count);
  assert.match(f.notices.at(-1).text, /Edits and commands ask first/);
  f.choices.push("edits");
  await f.run();
  assert.equal(f.permissions.mode(), "edits");
  assert.deepEqual(
    f.command.getArgumentCompletions("re").map((x) => x.value),
    ["read-only"],
  );
});

test("busy, invalid, cancelled and headless permission changes cannot change policy", async () => {
  const f = commands();
  f.busy(true);
  await f.run("edits");
  assert.match(f.notices.at(-1).text, /current run/);
  await f.run("fuck-it");
  f.busy(false);
  for (const mode of ["all", "wrong", "__proto__", "constructor"])
    await f.run(mode);
  await f.run(); // cancelled selector
  assert.equal(f.count(), 0);
  assert.equal(f.permissions.mode(), "ask");
  f.ctx.mode = "rpc";
  await f.run("edits");
  await f.run("fuck-it");
  assert.equal(f.count(), 0);
  assert.match(f.notices.at(-1).text, /Headless permissions are fixed/);
  f.ctx.mode = "tui";
  f.ctx.hasUI = false;
  await f.run("edits");
  assert.equal(f.count(), 0);
});

test("permission changes recheck busy state after an open menu and preserve launch read-only", async () => {
  const f = commands();
  f.ctx.ui.select = async () => {
    f.busy(true);
    return "edits";
  };
  await f.run();
  assert.equal(f.count(), 0);
  const locked = commands({
    readOnly: true,
    approveWrites: true,
    approveCommands: true,
  });
  for (const mode of ["ask", "edits", "fuck-it"]) await locked.run(mode);
  assert.equal(locked.count(), 0);
  assert.equal(locked.permissions.read().approveWrites, false);
  assert.match(locked.notices.at(-1).text, /launched with --read-only/);
  const state = createPermissions();
  assert.throws(() =>
    state.change("edits", () => {
      throw Error("tool update failed");
    }),
  );
  assert.equal(state.mode(), "ask");
});

test("live permission choices reach policy enforcement and preserve protected file restrictions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-policy-permissions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = createPermissions(),
    hooks = {},
    blocks = [];
  policyExtension({
    root,
    readPermissions: p.read,
    onPolicyBlock: (b) => blocks.push(b),
  })({ on: (name, handler) => (hooks[name] = handler) });
  const write = (name) =>
    hooks.tool_call(
      { toolName: "write", input: { path: name, content: "x" } },
      { hasUI: false },
    );
  assert.equal((await write("one.txt")).block, true);
  p.change("edits");
  assert.equal(await write("two.txt"), undefined);
  assert.equal((await write(".env")).block, true);
  const shell = await hooks.tool_call(
    { toolName: "powershell", input: { command: "echo test" } },
    { hasUI: false },
  );
  assert.equal(shell.block, true);
  p.change("read-only");
  assert.match((await write("three.txt")).reason, /Read-only/);
  p.change("ask");
  assert.equal((await write("four.txt")).block, true);
  assert.equal(blocks.length, 5);
});

test("existing header/footer components follow live permission changes", () => {
  const p = createPermissions(),
    theme = { fg: (_c, text) => text, bold: (text) => text },
    config = validateConfig({ model: "fixture" });
  const header = headerFactory({ version: "test", mode: p.display })(
    null,
    theme,
  );
  const footer = footerFactory({
    getContext: () => undefined,
    read: () => config,
    mode: p.display,
  })({ requestRender() {} }, theme, {});
  assert.match(header.render(150).join("\n"), /Edits and commands ask first/);
  p.change("edits");
  assert.match(header.render(150).join("\n"), /Edits apply without asking/);
  assert.match(footer.render(150).join("\n"), /edits auto-approved/);
  p.change("fuck-it");
  assert.match(
    header.render(150).join("\n"),
    /Edits and shell commands run without asking/,
  );
  assert.match(footer.render(150).join("\n"), /Fuck it Mode/);
  p.change("read-only");
  assert.match(header.render(150).join("\n"), /Read-only/);
  assert.match(footer.render(150).join("\n"), /read-only/);
});

test(
  "the actual Pi command updates executable tools without model calls or extra history",
  { timeout: 30000 },
  async (t) => {
    const home = fs.mkdtempSync(
        path.join(fs.realpathSync.native(os.tmpdir()), "hd-live-permissions-"),
      ),
      cwd = path.join(home, "work");
    fs.mkdirSync(cwd);
    const calls = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (b) => (raw += b));
      req.on("end", () => {
        const b = JSON.parse(raw);
        calls.push(b);
        const lastUser = b.messages.findLast(
          (m) =>
            m.role === "user" &&
            /Create first file|Create second file|Run shell in Fuck it Mode/.test(
              JSON.stringify(m.content),
            ),
        );
        const name = JSON.stringify(lastUser?.content).includes("second")
          ? "second.txt"
          : "first.txt";
        const toolResult = b.messages.at(-1)?.role === "tool";
        const shell = JSON.stringify(lastUser?.content).includes("Run shell");
        const delta = toolResult
          ? { content: "Done" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: (shell ? "shell-" : "write-") + name,
                  type: "function",
                  function: {
                    name: shell
                      ? process.platform === "win32"
                        ? "powershell"
                        : "bash"
                      : "write",
                    arguments: JSON.stringify(
                      shell
                        ? { command: "echo FUCK_IT_COMMAND_OK" }
                        : { path: name, content: "saved" },
                    ),
                  },
                },
              ],
            };
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                { delta, finish_reason: toolResult ? "stop" : "tool_calls" },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const runtime = await createRuntime({
      home,
      cwd,
      token: "a".repeat(64),
      config: validateConfig({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: "fixture",
        maxTokens: 128,
      }),
    });
    t.after(async () => {
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(home, { recursive: true, force: true });
    });
    const notices = [],
      theme = { fg: (_c, text) => text };
    await runtime.session.bindExtensions({
      mode: "tui",
      uiContext: {
        theme,
        notify: (text) => notices.push(text),
        setStatus() {},
        onTerminalInput: () => () => {},
        setHeader() {},
        setFooter() {},
        setWorkingIndicator() {},
        setHiddenThinkingLabel() {},
        setTitle() {},
        setWorkingMessage() {},
        confirm: async () => false,
      },
    });
    const before = runtime.session.messages.length;
    await runtime.session.prompt("/permissions edits");
    assert.equal(calls.length, 0);
    assert.equal(runtime.session.messages.length, before);
    await runtime.session.prompt("Create first file");
    assert.equal(fs.readFileSync(path.join(cwd, "first.txt"), "utf8"), "saved");
    await runtime.session.prompt("/permissions fuck-it");
    await runtime.session.prompt("Run shell in Fuck it Mode");
    assert.match(
      JSON.stringify(calls.at(-1).messages.filter((m) => m.role === "tool")),
      /FUCK_IT_COMMAND_OK/,
    );
    await runtime.session.prompt("/permissions read-only");
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), [
      "ls",
      "read",
      "search",
    ]);
    await runtime.session.prompt("/permissions ask");
    assert.ok(runtime.session.getActiveToolNames().includes("write"));
    await runtime.session.prompt("Create second file");
    assert.equal(fs.existsSync(path.join(cwd, "second.txt")), false);
    assert.ok(notices.some((text) => text.includes("Edits auto-approved")));
    assert.ok(
      notices.some((text) => text.includes("Edits and commands ask first")),
    );
    assert.equal(calls.length, 6);
    assert.equal(
      calls[0].messages[0].content,
      calls[4].messages[0].content,
      "ask/edits use stable system instructions",
    );
    assert.ok(
      !runtime.session.messages.some((m) =>
        JSON.stringify(m).includes("/permissions"),
      ),
    );
  },
);

test("Fuck it Mode uses its requested name, supports direct aliases, and auto-approves both mutation types", async (t) => {
  const f = commands();
  for (const alias of ["fuck-it", "fuck it", "fuck it mode"]) {
    await f.run(alias);
    assert.equal(f.permissions.mode(), "fuck-it");
    assert.deepEqual(f.permissions.read(), {
      readOnly: false,
      approveWrites: true,
      approveCommands: true,
    });
    assert.equal(f.permissions.display.short, "Fuck it Mode");
    assert.equal(f.permissions.display.tone, "warning");
  }
  assert.deepEqual(f.command.getArgumentCompletions("fu"), [
    { value: "fuck-it", label: "Fuck it Mode" },
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-fuck-it-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hooks = {};
  let approvals = 0;
  policyExtension({ root, readPermissions: f.permissions.read })({
    on: (name, handler) => (hooks[name] = handler),
  });
  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: {
      confirm: async () => {
        approvals++;
        return false;
      },
    },
  };
  const call = (toolName, input) => hooks.tool_call({ toolName, input }, ctx);
  assert.equal(
    await call("write", { path: "example.txt", content: "x" }),
    undefined,
  );
  assert.equal(
    await call("powershell", { command: "echo allowed" }),
    undefined,
  );
  assert.equal(approvals, 0);
  assert.match(
    (await call("write", { path: ".env", content: "x" })).reason,
    /Protected path/,
  );
  await f.run("ask");
  assert.equal(
    (await call("powershell", { command: "echo ask-again" })).block,
    true,
  );
  assert.equal(approvals, 1, "returning to ask restores command approval");
});
