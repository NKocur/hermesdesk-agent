import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Writable } from "node:stream";
import {
  validateConfig,
  saveConfig,
  loadConfig,
  projectSessionDir,
} from "../src/config.js";
import { workspacePath, policyExtension } from "../src/policy.js";
import { nativeFetch, modelFetch, curlFetch } from "../src/transport.js";
import { saveCredential, getCredential } from "../src/credentials.js";
import { createRuntime, runPrompt } from "../src/agent.js";
function folder(t) {
  const p = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), "hermesdesk-agent-test-"),
  );
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
async function serve(t, handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(async () => {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  });
  return "http://127.0.0.1:" + s.address().port;
}
test("configuration rejects unsafe endpoints and invalid budgets; saves no credentials", (t) => {
  const home = folder(t);
  for (const c of [
    { baseUrl: "http://example.com/v1" },
    { baseUrl: "https://user:secret@example.com/v1" },
    { baseUrl: "https://example.com/v1?x=1" },
    { baseUrl: "https://example.com/api" },
    { maxTokens: 131073 },
    { thinking: "false" },
    { context: 42 },
  ])
    assert.throws(() => validateConfig(c));
  const c = saveConfig({ model: "fixture" }, home);
  assert.deepEqual(loadConfig(home), c);
  assert.ok(
    !fs.readFileSync(path.join(home, "config.json"), "utf8").includes("apiKey"),
  );
});
test("workspace policy rejects traversal, protected files, aliases and linked outside directories", (t) => {
  const top = folder(t),
    root = path.join(top, "work"),
    outside = path.join(top, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, ".git"));
  assert.equal(
    workspacePath(root, "src/new.js"),
    path.join(root, "src/new.js"),
  );
  for (const p of [
    "../outside/a",
    ".env",
    ".env.local",
    ".git/config",
    "node_modules/x",
    "file:stream",
    "NUL",
    "config.",
  ])
    assert.throws(() => workspacePath(root, p));
  fs.symlinkSync(
    outside,
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => workspacePath(root, "linked/new.txt"));
  fs.symlinkSync(
    path.join(root, ".git"),
    path.join(root, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => workspacePath(root, "alias/config"));
});
test("edits and commands require approval, readonly blocks changes, declined actions stay blocked", async (t) => {
  const root = folder(t);
  async function check(options, event, ctx) {
    const handlers = {};
    policyExtension({ root, ...options })({
      on: (name, f) => (handlers[name] = f),
    });
    return handlers.tool_call(
      { toolName: "write", input: { path: "x", content: "x" }, ...event },
      { hasUI: false, ...ctx },
    );
  }
  assert.equal((await check({})).block, true);
  assert.equal(await check({ approveWrites: true }), undefined);
  assert.equal(
    (await check({ readOnly: true, approveWrites: true })).block,
    true,
  );
  assert.equal(
    (
      await check(
        { approveWrites: true },
        { toolName: "powershell", input: { command: "whoami" } },
      )
    ).block,
    true,
  );
  assert.equal(
    (
      await check({}, undefined, {
        hasUI: true,
        ui: { confirm: async () => false },
      })
    ).block,
    true,
  );
  assert.equal(
    await check({}, undefined, {
      hasUI: true,
      ui: { confirm: async () => true },
    }),
    undefined,
  );
});
test("native fetch preserves streaming, aborts requests, and never follows credential-bearing redirects", async (t) => {
  let foreign = 0;
  const other = await serve(t, (_q, r) => {
    foreign++;
    r.end("bad");
  });
  const base = await serve(t, (q, r) => {
    if (q.url === "/redirect") {
      r.writeHead(302, { Location: other });
      r.end();
    } else if (q.url === "/slow") {
    } else {
      r.setHeader("Content-Type", "text/event-stream");
      r.write("data: one\n\n");
      setTimeout(() => r.end("data: two\n\n"), 20);
    }
  });
  const r = await nativeFetch(base + "/stream");
  assert.match(await r.text(), /one[\s\S]*two/);
  assert.equal(
    (
      await nativeFetch(base + "/redirect", {
        headers: { Authorization: "Bearer fake" },
      })
    ).status,
    302,
  );
  assert.equal(foreign, 0);
  await assert.rejects(
    nativeFetch(base + "/slow", { signal: AbortSignal.timeout(30) }),
  );
  assert.throws(() => modelFetch(base + "/v1")(other + "/v1/models"));
});
test(
  "Windows credential storage is encrypted and bound to the selected endpoint",
  { skip: process.platform !== "win32" },
  async (t) => {
    const home = folder(t),
      token = "t".repeat(64);
    assert.ok(
      !process.env.HERMESDESK_API_KEY,
      "Run tests without an inherited API key",
    );
    await saveCredential(home, "https://fixture.test/v1", token);
    assert.ok(
      !fs
        .readFileSync(path.join(home, "credential.dpapi"), "utf8")
        .includes(token),
    );
    assert.equal(await getCredential(home, "https://fixture.test/v1"), token);
    await assert.rejects(
      getCredential(home, "https://other.test/v1"),
      /different endpoint/,
    );
  },
);
async function modelServer(t, mode = "read") {
  const calls = [];
  const base = await serve(t, (req, res) => {
    let raw = "";
    req.on("data", (b) => (raw += b));
    req.on("end", () => {
      const b = JSON.parse(raw);
      calls.push(b);
      const results = b.messages.filter((m) => m.role === "tool");
      let content = null,
        tools,
        finish = "stop";
      if (typeof mode === "function") {
        const next = mode(b, calls);
        if (next.tool) {
          tools = [
            {
              index: 0,
              id: "fixture_" + calls.length,
              type: "function",
              function: {
                name: next.tool.name,
                arguments: JSON.stringify(next.tool.input),
              },
            },
          ];
          finish = "tool_calls";
        } else content = next.text;
      } else if (
        !results.length ||
        (mode === "long-read" && calls.length <= 65)
      ) {
        tools = [
          {
            index: 0,
            id:
              mode === "long-read" ? "fixture_" + calls.length : "fixture_call",
            type: "function",
            function: {
              name:
                mode === "search"
                  ? "search"
                  : ["read", "long-read"].includes(mode)
                    ? "read"
                    : "write",
              arguments: JSON.stringify(
                mode === "search"
                  ? { query: "MARKER_428" }
                  : ["read", "long-read"].includes(mode)
                    ? {
                        path:
                          mode === "long-read"
                            ? "step-" + calls.length + ".txt"
                            : "README.txt",
                      }
                    : { path: "hello.txt", content: "HELLO_FROM_PI\n" },
              ),
            },
          },
        ];
        finish = "tool_calls";
      } else
        content = JSON.stringify(results).includes("MARKER_428")
          ? "MARKER_428 confirmed"
          : JSON.stringify(results).includes("denied") ||
              JSON.stringify(results).includes("approval")
            ? "Write denied"
            : "Write finished";
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  ...(content ? { content } : { tool_calls: tools }),
                },
                finish_reason: finish,
              },
            ],
          }) +
          "\n\n",
      );
      res.end(
        "data: " +
          JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 123,
              completion_tokens: 12,
              total_tokens: 135,
            },
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
  });
  return { baseUrl: base + "/v1", calls };
}
async function session(t, mode, approveWrites = false, overrides = {}) {
  const home = folder(t),
    cwd = path.join(home, "work");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "README.txt"), "MARKER_428");
  fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "extensions", "untrusted.js"),
    "throw Error('UNTRUSTED_EXTENSION_EXECUTED')",
  );
  const server = await modelServer(t, mode),
    runtime = await createRuntime({
      home,
      cwd,
      token: "a".repeat(64),
      config: validateConfig({
        ...server,
        model: "fixture",
        maxTokens: 32,
        ...overrides,
      }),
      approveWrites,
    });
  t.after(() => runtime.dispose());
  let text = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      text += chunk;
      cb();
    },
  });
  await runPrompt(runtime, "Do the fixture task", { out });
  return { home, cwd, runtime, calls: server.calls, text };
}
test("actual Pi loop reads a workspace file, replays tool result and persists only its own session", async (t) => {
  const r = await session(t, "read");
  assert.match(r.text, /MARKER_428/);
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls[0].tools.some((x) => x.function.name === "read"));
  assert.ok(r.calls[0].tools.length <= 7);
  assert.equal(r.calls[0].max_tokens, 32);
  assert.equal(r.calls[0].chat_template_kwargs.enable_thinking, false);
  assert.equal(
    r.calls[1].messages.find((m) => m.role === "tool").tool_call_id,
    "fixture_call",
  );
  const file = r.runtime.session.sessionManager.getSessionFile();
  assert.ok(file.startsWith(r.home));
  assert.ok(!fs.readFileSync(file, "utf8").includes("a".repeat(64)));
});
test("actual Pi loop cannot write without headless opt-in; explicit opt-in writes a workspace artifact", async (t) => {
  const denied = await session(t, "write");
  assert.ok(!fs.existsSync(path.join(denied.cwd, "hello.txt")));
  const allowed = await session(t, "write", true);
  assert.equal(
    fs.readFileSync(path.join(allowed.cwd, "hello.txt"), "utf8"),
    "HELLO_FROM_PI\n",
  );
});

test(
  "a productive Pi job continues past 64 requests and ignores a legacy saved request cap",
  { timeout: 45000 },
  async (t) => {
    const home = folder(t),
      cwd = path.join(home, "work");
    fs.mkdirSync(cwd);
    for (let i = 1; i <= 65; i++)
      fs.writeFileSync(
        path.join(cwd, "step-" + i + ".txt"),
        "MARKER_428 step " + i,
      );
    const server = await modelServer(t, "long-read");
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        baseUrl: server.baseUrl,
        model: "fixture",
        maxTokens: 32,
        maxRequests: 1,
      }),
    );
    const config = loadConfig(home);
    assert.equal(Object.hasOwn(config, "maxRequests"), false);
    const runtime = await createRuntime({
      home,
      cwd,
      token: "a".repeat(64),
      config,
    });
    try {
      let text = "";
      await runPrompt(runtime, "Read each numbered step file and finish", {
        out: new Writable({
          write(chunk, _encoding, callback) {
            text += chunk;
            callback();
          },
        }),
      });
      assert.equal(server.calls.length, 66);
      assert.match(text, /MARKER_428 confirmed/);
      assert.equal(
        server.calls.at(-1).messages.filter((m) => m.role === "tool").length,
        65,
      );
      saveConfig(config, home);
      assert.equal(
        Object.hasOwn(
          JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")),
          "maxRequests",
        ),
        false,
      );
    } finally {
      await runtime.dispose();
    }
  },
);

test("continuing a project restores its persisted messages, and session listing finds that project", async (t) => {
  const r = await session(t, "read");
  await r.runtime.dispose();
  const server = await modelServer(t, "read");
  const next = await createRuntime({
    home: r.home,
    cwd: r.cwd,
    token: "a".repeat(64),
    config: validateConfig({ ...server, model: "fixture", maxTokens: 32 }),
    continueSession: true,
  });
  try {
    assert.ok(next.session.messages.some((m) => m.role === "toolResult"));
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sessions = await SessionManager.list(
      r.cwd,
      projectSessionDir(r.home, r.cwd),
    );
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].cwd, r.cwd);
  } finally {
    await next.dispose();
  }
});
test("manual bang commands cannot bypass the managed command approval path", async (t) => {
  const r = await session(t, "read");
  const target = path.join(r.cwd, "bang-bypass.txt");
  const command =
    process.platform === "win32"
      ? `echo bypass > "${target}"`
      : `touch "${target}"`;
  const blocked = await r.runtime.session.extensionRunner.emitUserBash({
    type: "user_bash",
    command,
    excludeFromContext: false,
    cwd: r.cwd,
  });
  assert.equal(blocked.result.cancelled, true);
  assert.ok(!fs.existsSync(target));
});

test(
  "Windows curl transport preserves JSON escaping, Unicode, streaming, cancellation and redirect isolation",
  { skip: process.platform !== "win32" },
  async (t) => {
    let received;
    const base = await serve(t, (q, r) => {
      if (q.url === "/slow") return;
      if (q.url === "/redirect") {
        r.writeHead(302, { Location: "https://example.invalid/" });
        r.end();
        return;
      }
      let raw = "";
      q.on("data", (b) => (raw += b));
      q.on("end", () => {
        received = JSON.parse(raw);
        r.setHeader("Content-Type", "text/event-stream");
        r.write("data: first\n\n");
        setTimeout(() => r.end("data: last\n\n"), 10);
      });
    });
    const content = 'quote " slash \\ newline\n tab\t snowman \u2603';
    const r = await curlFetch(base + "/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    assert.match(await r.text(), /first[\s\S]*last/);
    assert.equal(received.content, content);
    const redirect = await curlFetch(base + "/redirect");
    assert.equal(redirect.status, 302);
    await redirect.body.cancel();
    await assert.rejects(
      curlFetch(base + "/slow", { signal: AbortSignal.timeout(100) }),
    );
  },
);

test("recursive literal search excludes protected files and linked outside files", async (t) => {
  const { searchWorkspace } = await import("../src/search.js");
  const top = folder(t),
    root = path.join(top, "work"),
    outside = path.join(top, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "allowed.txt"), "SEARCH_MARKER public");
  fs.writeFileSync(path.join(root, ".env"), "SEARCH_MARKER secret");
  fs.writeFileSync(path.join(outside, "secret.txt"), "SEARCH_MARKER outside");
  fs.symlinkSync(
    outside,
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await searchWorkspace(root, { query: "SEARCH_MARKER" });
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0], /allowed.txt/);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("the actual Pi agent can invoke the custom search schema and receive matching project text", async (t) => {
  const r = await session(t, "search");
  const result = r.calls[1].messages.find((m) => m.role === "tool");
  assert.match(JSON.stringify(result.content), /MARKER_428/);
});

test("unsupported Node versions are rejected before the client attempts connection", async () => {
  const { supportedNode } = await import("../src/config.js");
  assert.equal(supportedNode("22.17.1"), false);
  assert.equal(supportedNode("22.18.0"), false);
  assert.equal(supportedNode("22.19.0"), true);
  assert.equal(supportedNode("24.19.0"), true);
  assert.equal(supportedNode("20.20.0"), false);
});

test(
  "cancelling a rejected streamed curl response does not enqueue into a closed controller",
  { skip: process.platform !== "win32" },
  async (t) => {
    let responsesClosed = 0;
    const base = await serve(t, (_q, r) => {
      r.writeHead(403, {
        "Content-Type": "text/html",
        "cf-mitigated": "challenge",
        "cf-ray": "fixture-ray",
      });
      r.write("<html>Challenge");
      const timer = setInterval(() => r.write("x".repeat(65536)), 2);
      r.on("close", () => {
        clearInterval(timer);
        responsesClosed++;
      });
    });
    const { discover } = await import("../src/transport.js");
    for (let i = 0; i < 4; i++)
      await assert.rejects(
        discover({ baseUrl: base + "/v1" }, "a".repeat(64)),
        (e) =>
          e.code === "CLOUDFLARE_CHALLENGE" &&
          e.message.includes("fixture-ray"),
      );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(responsesClosed, 4);
  },
);

test(
  "Windows curl delivers small SSE events before the server finishes",
  { skip: process.platform !== "win32" },
  async (t) => {
    let finish;
    const base = await serve(t, (_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write("data: first\n\n");
      // The server cannot finish until the client sees the first tiny event.
      finish = () => res.end("data: [DONE]\n\n");
    });
    const response = await curlFetch(base + "/stream", {
      signal: AbortSignal.timeout(3000),
    });
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.match(new TextDecoder().decode(first.value), /data: first/);
      finish();
      let remaining = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        remaining += new TextDecoder().decode(next.value);
      }
      assert.match(remaining, /\[DONE\]/);
    } finally {
      finish?.();
      await reader.cancel().catch(() => {});
    }
  },
);

test("extended thinking profile reaches the actual Pi tool loop without an 8K clamp", async (t) => {
  const { profile } = await import("../src/generation.js");
  const r = await session(t, "read", false, {
    ...profile("extended"),
    thinkingBudget: 16384,
  });
  assert.match(r.text, /MARKER_428/);
  assert.equal(r.calls.length, 2);
  for (const call of r.calls) {
    assert.equal(call.max_tokens, 131072);
    assert.equal(call.reasoning_effort, "xhigh");
    assert.equal(call.reasoning_budget_tokens, 16384);
    assert.equal(call.chat_template_kwargs.enable_thinking, true);
    assert.equal(call.temperature, 1);
    assert.equal(call.top_p, 0.95);
    assert.equal(call.presence_penalty, 0);
  }
});

test("actual Pi slash commands apply immediately without model calls and native thinking controls reach Strata", async (t) => {
  const r = await session(t, "read");
  const before = r.calls.length,
    messages = r.runtime.session.messages.length;
  await r.runtime.session.prompt("/profile extended");
  assert.equal(r.runtime.session.model.maxTokens, 131072);
  assert.equal(r.runtime.session.thinkingLevel, "high");
  assert.equal(
    r.runtime.session.settingsManager.getCompactionSettings().reserveTokens,
    133120,
  );
  await r.runtime.session.prompt("/tokens 65536");
  await r.runtime.session.prompt("/thinking-budget 8192");
  assert.equal(r.calls.length, before);
  assert.equal(r.runtime.session.messages.length, messages);
  assert.equal(r.runtime.session.model.maxTokens, 65536);
  assert.equal(
    r.runtime.session.settingsManager.getCompactionSettings().reserveTokens,
    67584,
  );
  await r.runtime.session.prompt("Confirm the previous marker again.");
  assert.equal(r.calls.at(-1).max_tokens, 65536);
  assert.equal(r.calls.at(-1).reasoning_effort, "xhigh");
  assert.equal(r.calls.at(-1).reasoning_budget_tokens, 8192);
  r.runtime.session.setThinkingLevel("off");
  await r.runtime.session.prompt("Confirm the marker once more.");
  assert.equal(r.calls.at(-1).reasoning_effort, "none");
  assert.equal(r.calls.at(-1).chat_template_kwargs.enable_thinking, false);
  r.runtime.session.setThinkingLevel("medium");
  await r.runtime.session.prompt("Confirm the marker finally.");
  assert.equal(r.calls.at(-1).reasoning_effort, "medium");
  assert.equal(r.calls.at(-1).reasoning_budget_tokens, 8192);
});

test(
  "actual Pi stops an unrecovered edit loop, preserves prior edits, and can resume on a new message",
  { timeout: 30000 },
  async (t) => {
    const home = folder(t),
      cwd = path.join(home, "work");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "source.txt"), "ORIGINAL\n");
    const server = await modelServer(t, (_body, calls) => {
      const n = calls.length;
      if (n === 1)
        return {
          tool: {
            name: "edit",
            input: {
              path: "source.txt",
              oldText: "ORIGINAL",
              newText: "UPDATED",
            },
          },
        };
      if (n <= 5)
        return {
          tool: {
            name: "edit",
            input:
              n % 2
                ? {
                    newText: "WRONG",
                    path: "source.txt",
                    oldText: "MISSING_TEXT",
                  }
                : {
                    path: "source.txt",
                    oldText: "MISSING_TEXT",
                    newText: "WRONG",
                  },
          },
        };
      return { text: "RESUMED_OK" };
    });
    const runtime = await createRuntime({
      home,
      cwd,
      token: "a".repeat(64),
      approveWrites: true,
      config: validateConfig({ ...server, model: "fixture", maxTokens: 64 }),
    });
    const { runHeadless } = await import("../src/headless.js");
    const output = () =>
      new Writable({
        write(_b, _e, cb) {
          cb();
        },
      });
    try {
      const stopped = await runHeadless(runtime, "Perform fixture edits", {
        format: "json",
        out: output(),
        err: output(),
      });
      assert.equal(
        server.calls.length,
        5,
        "no sixth model call after the repeated failure",
      );
      assert.equal(stopped.status, "failed");
      assert.equal(stopped.exitCode, 1);
      assert.equal(stopped.ok, false);
      assert.match(
        stopped.error,
        /Stopped a repeated-tool loop.*edit source.txt/,
      );
      assert.equal(
        fs.readFileSync(path.join(cwd, "source.txt"), "utf8"),
        "UPDATED\n",
      );
      assert.ok(
        runtime.session.messages.some(
          (m) => m.role === "toolResult" && m.isError,
        ),
      );
      const resumed = await runHeadless(
        runtime,
        "Continue with a different approach",
        { format: "json", out: output(), err: output() },
      );
      assert.equal(resumed.status, "completed");
      assert.equal(resumed.text, "RESUMED_OK");
      assert.equal(runtime.getLoopStopReason(), undefined);
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "actual Pi recovers from a stale edit by rereading and correcting the replacement",
  { timeout: 30000 },
  async (t) => {
    const home = folder(t),
      cwd = path.join(home, "work");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "source.txt"), "CURRENT\n");
    const server = await modelServer(t, (body, calls) => {
      const n = calls.length;
      if (n <= 3)
        return {
          tool: {
            name: "edit",
            input: { path: "source.txt", oldText: "STALE", newText: "WRONG" },
          },
        };
      if (n === 4) {
        assert.match(
          body.messages.filter((m) => m.role === "tool").at(-1).content,
          /Recovery:.*Read the current file/s,
        );
        return { tool: { name: "read", input: { path: "source.txt" } } };
      }
      if (n === 5)
        return {
          tool: {
            name: "edit",
            input: {
              path: "source.txt",
              oldText: "CURRENT",
              newText: "CORRECTED",
            },
          },
        };
      return { text: "RECOVERY_OK" };
    });
    const denials = [],
      runtime = await createRuntime({
        home,
        cwd,
        token: "a".repeat(64),
        approveWrites: true,
        onPolicyBlock: (e) => denials.push(e),
        config: validateConfig({ ...server, model: "fixture", maxTokens: 64 }),
      });
    const { runHeadless } = await import("../src/headless.js");
    const output = () =>
      new Writable({
        write(_b, _e, cb) {
          cb();
        },
      });
    try {
      const result = await runHeadless(runtime, "Perform fixture edit", {
        format: "json",
        denials,
        out: output(),
        err: output(),
      });
      assert.equal(server.calls.length, 6);
      assert.equal(result.status, "completed");
      assert.equal(result.exitCode, 0);
      assert.equal(result.text, "RECOVERY_OK");
      assert.deepEqual(denials, []);
      assert.equal(
        fs.readFileSync(path.join(cwd, "source.txt"), "utf8"),
        "CORRECTED\n",
      );
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "rereading between identical failed edits does not keep an actual Pi loop alive",
  { timeout: 30000 },
  async (t) => {
    const home = folder(t),
      cwd = path.join(home, "work");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "source.txt"), "CURRENT\n");
    const server = await modelServer(t, (_body, calls) =>
      calls.length > 8
        ? { text: "FAILSAFE" }
        : {
            tool:
              calls.length % 2
                ? {
                    name: "edit",
                    input: {
                      path: "source.txt",
                      oldText: "MISSING",
                      newText: "WRONG",
                    },
                  }
                : { name: "read", input: { path: "source.txt" } },
          },
    );
    const runtime = await createRuntime({
      home,
      cwd,
      token: "a".repeat(64),
      approveWrites: true,
      config: validateConfig({ ...server, model: "fixture", maxTokens: 64 }),
    });
    try {
      await assert.rejects(
        runPrompt(runtime, "Perform fixture edit", {
          out: new Writable({
            write(_b, _e, cb) {
              cb();
            },
          }),
        }),
        /Stopped a repeated-tool loop/,
      );
      assert.equal(server.calls.length, 7);
      assert.equal(
        fs.readFileSync(path.join(cwd, "source.txt"), "utf8"),
        "CURRENT\n",
      );
    } finally {
      await runtime.dispose();
    }
  },
);
