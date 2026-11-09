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
      if (!results.length) {
        tools = [
          {
            index: 0,
            id: "fixture_call",
            type: "function",
            function: {
              name:
                mode === "search"
                  ? "search"
                  : mode === "read"
                    ? "read"
                    : "write",
              arguments: JSON.stringify(
                mode === "search"
                  ? { query: "MARKER_428" }
                  : mode === "read"
                    ? { path: "README.txt" }
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

test("model request budget stops repeated tool loops without more network calls", async (t) => {
  const home = folder(t),
    cwd = path.join(home, "work");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "README.txt"), "MARKER_428");
  const server = await modelServer(t, "read");
  const runtime = await createRuntime({
    home,
    cwd,
    token: "a".repeat(64),
    config: validateConfig({
      ...server,
      model: "fixture",
      maxTokens: 32,
      maxRequests: 1,
    }),
  });
  try {
    await assert.rejects(
      runPrompt(runtime, "Read README.txt", {
        out: new Writable({
          write(_b, _e, cb) {
            cb();
          },
        }),
      }),
      /budget|did not complete/,
    );
    assert.equal(server.calls.length, 1);
  } finally {
    await runtime.dispose();
  }
});
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
