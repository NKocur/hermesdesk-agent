import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { readPrompt, INPUT_LIMIT, outputFormat } from "../src/headless.js";
import { policyExtension } from "../src/policy.js";

const entry = fileURLToPath(new URL("../bin/hermesdesk.js", import.meta.url));
function reply(res, { text = "JOB_OK", tool, finish = "stop" } = {}) {
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: tool
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "job-tool",
                      type: "function",
                      function: {
                        name: tool.name,
                        arguments: JSON.stringify(tool.input),
                      },
                    },
                  ],
                }
              : { content: text },
            finish_reason: tool ? "tool_calls" : finish,
          },
        ],
      }) +
      "\n\ndata: " +
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
}
async function fixture(t, handler = (_body, res) => reply(res)) {
  const home = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), "hermes-headless-"),
  );
  const cwd = path.join(home, "work");
  fs.mkdirSync(cwd);
  const calls = [],
    children = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (b) => (raw += b));
    req.on("end", () => {
      const body = JSON.parse(raw);
      calls.push(body);
      handler(body, res);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: "fixture",
      maxTokens: 64,
    }),
  );
  function start(args, { stdin, noToken = false } = {}) {
    const env = {
      ...process.env,
      HERMESDESK_AGENT_HOME: home,
      HERMESDESK_API_KEY: "a".repeat(64),
    };
    for (const key of [
      "HERMESDESK_ACCESS_CLIENT_ID",
      "HERMESDESK_ACCESS_CLIENT_SECRET",
      "HERMESDESK_CONNECTION_CODE",
    ])
      delete env[key];
    if (noToken) delete env.HERMESDESK_API_KEY;
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "",
      stderr = "",
      buffer = "";
    const records = [],
      waiting = new Set();
    child.stdout.on("data", (b) => {
      stdout += b;
      buffer += b;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          records.push(JSON.parse(line));
        } catch {}
      }
      for (const notify of waiting) notify();
    });
    child.stderr.on("data", (b) => (stderr += b));
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        resolve({ code, signal, stdout, stderr, records }),
      );
    });
    const wait = (predicate) =>
      new Promise((resolve, reject) => {
        const notify = () => {
          const found = records.find(predicate);
          if (found) {
            clearTimeout(timer);
            waiting.delete(notify);
            resolve(found);
          }
        };
        const timer = setTimeout(() => {
          waiting.delete(notify);
          reject(
            Error("Timed out waiting for protocol output: " + stdout + stderr),
          );
        }, 15000);
        waiting.add(notify);
        notify();
      });
    if (stdin !== undefined) child.stdin.end(stdin);
    return {
      child,
      done,
      wait,
      records,
      send: (value) => child.stdin.write(JSON.stringify(value) + "\n"),
    };
  }
  t.after(async () => {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) c.kill();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, cwd, calls, start };
}

test("headless requests read UTF-8 stdin/files, reject ambiguous sources and enforce limits", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-prompt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "prompt.txt");
  fs.writeFileSync(file, "\uFEFFDescribe café 🐈");
  assert.equal(await readPrompt({ promptFile: file }), "Describe café 🐈");
  assert.equal(
    await readPrompt({
      stdin: true,
      input: Readable.from([Buffer.from("café 🐈")]),
    }),
    "café 🐈",
  );
  assert.equal(await readPrompt({ args: ["Explain", "this"] }), "Explain this");
  for (const options of [
    {},
    { args: ["x"], promptFile: file },
    { args: ["x"], stdin: true },
    { args: ["!bad"] },
  ])
    await assert.rejects(readPrompt(options), (error) => error.exitCode === 2);
  await assert.rejects(
    readPrompt({
      stdin: true,
      input: Readable.from([Buffer.alloc(INPUT_LIMIT + 1, 120)]),
    }),
    /1 MiB/,
  );
  assert.equal(outputFormat(undefined, true), "jsonl");
  assert.throws(() => outputFormat("json", true), /alias/);
});

test(
  "one-shot JSON is one clean result; stdin/file input and JSONL stream through the real CLI",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.start([
      "run",
      "Explain this",
      "--output-format",
      "json",
    ]).done;
    assert.equal(first.code, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.text, "JOB_OK");
    assert.equal(result.status, "completed");
    assert.deepEqual(result.usage, { input: 40, output: 10 });
    assert.equal(first.stderr, "");
    assert.ok(result.session);
    const second = await f.start(
      ["run", "-", "--json", "--max-requests", "3"],
      { stdin: "UTF8 café 🐈" },
    ).done;
    assert.equal(second.code, 0, second.stderr);
    for (const line of second.stdout.trim().split("\n")) JSON.parse(line);
    assert.equal(second.records[0].type, "start");
    assert.equal(second.records.at(-1).type, "done");
    assert.ok(JSON.stringify(f.calls.at(-1)).includes("UTF8 café 🐈"));
    const file = path.join(f.home, "outside-work-request.txt");
    fs.writeFileSync(file, "Read the source");
    const third = await f.start([
      "run",
      "--prompt-file",
      file,
      "--output-format",
      "json",
    ]).done;
    assert.equal(third.code, 0, third.stderr);
  },
);

test(
  "headless sessions resume prior context and list as machine-readable JSON",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const first = JSON.parse(
      (
        await f.start([
          "run",
          "FIRST_CONTEXT_MARKER",
          "--output-format",
          "json",
        ]).done
      ).stdout,
    );
    const second = await f.start([
      "run",
      "Continue the work",
      "--session",
      first.session,
      "--output-format",
      "json",
    ]).done;
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).session, first.session);
    assert.ok(
      JSON.stringify(f.calls.at(-1).messages).includes("FIRST_CONTEXT_MARKER"),
    );
    const listed = await f.start(["sessions", "--output-format", "json"]).done;
    assert.ok(JSON.parse(listed.stdout).some((s) => s.id === first.session));
  },
);

test(
  "headless file writes are denied with exit 3 until explicitly allowed; protected paths stay blocked",
  { timeout: 45000 },
  async (t) => {
    let target = "created.txt";
    const f = await fixture(t, (body, res) =>
      body.messages.some((m) => m.role === "tool")
        ? reply(res)
        : reply(res, {
            tool: { name: "write", input: { path: target, content: "saved" } },
          }),
    );
    const denied = await f.start([
      "run",
      "Create file",
      "--output-format",
      "json",
    ]).done;
    assert.equal(denied.code, 3, denied.stdout + denied.stderr);
    assert.equal(JSON.parse(denied.stdout).status, "blocked");
    assert.equal(fs.existsSync(path.join(f.cwd, target)), false);
    const allowed = await f.start([
      "run",
      "Create file",
      "--approve-writes",
      "--output-format",
      "json",
    ]).done;
    assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
    assert.equal(fs.readFileSync(path.join(f.cwd, target), "utf8"), "saved");
    target = ".env";
    const protectedRun = await f.start([
      "run",
      "Create file",
      "--approve-writes",
      "--output-format",
      "json",
    ]).done;
    assert.equal(protectedRun.code, 3);
    assert.equal(fs.existsSync(path.join(f.cwd, target)), false);
  },
);

test("command pre-approval is explicit and read-only still blocks it", async (t) => {
  const f = await fixture(t);
  const hooks = {},
    denied = [];
  policyExtension({
    root: f.cwd,
    approveCommands: true,
    onPolicyBlock: (event) => denied.push(event),
  })({ on: (name, handler) => (hooks[name] = handler) });
  const event = {
    toolName: process.platform === "win32" ? "powershell" : "bash",
    input: { command: "echo test" },
  };
  assert.equal(await hooks.tool_call(event, { hasUI: false }), undefined);
  policyExtension({
    root: f.cwd,
    approveCommands: true,
    readOnly: true,
    onPolicyBlock: (event) => denied.push(event),
  })({ on: (name, handler) => (hooks[name] = handler) });
  assert.equal((await hooks.tool_call(event, { hasUI: false })).block, true);
  assert.match(denied[0].reason, /Read-only/);
});

test(
  "timeouts stop the actual streaming request and output-limit stops have a distinct exit code",
  { timeout: 30000 },
  async (t) => {
    let closed = false,
      slow = true;
    const f = await fixture(t, (_body, res) => {
      if (!slow) return reply(res, { text: "partial", finish: "length" });
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      );
      res.on("close", () => (closed = true));
    });
    const timed = await f.start([
      "run",
      "wait",
      "--timeout",
      "1",
      "--output-format",
      "json",
    ]).done;
    assert.equal(timed.code, 124, timed.stdout + timed.stderr);
    assert.equal(JSON.parse(timed.stdout).status, "timeout");
    assert.equal(closed, true);
    slow = false;
    const limited = await f.start(["run", "write", "--output-format", "json"])
      .done;
    assert.equal(limited.code, 4);
    assert.equal(JSON.parse(limited.stdout).status, "truncated");
  },
);

test(
  "startup and input failures emit structured errors without authentication prompts",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const invalid = await f.start([
      "run",
      "x",
      "--timeout",
      "zero",
      "--output-format",
      "json",
    ]).done;
    assert.equal(invalid.code, 2);
    assert.equal(JSON.parse(invalid.stdout).status, "invalid");
    const notConnected = await f.start(
      ["run", "x", "--output-format", "json"],
      { noToken: true },
    ).done;
    assert.equal(notConnected.code, 1);
    assert.match(JSON.parse(notConnected.stdout).error, /Not connected/);
    assert.equal(notConnected.stderr, "");
  },
);

test(
  "persistent headless protocol can reject busy requests, cancel work, reuse context and shut down",
  { timeout: 30000 },
  async (t) => {
    let slow = true,
      closed = false;
    const f = await fixture(t, (_body, res) => {
      if (!slow) return reply(res);
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        'data: {"choices":[{"delta":{"content":"waiting"},"finish_reason":null}]}\n\n',
      );
      res.on("close", () => (closed = true));
    });
    const job = f.start(["headless", "--read-only"]);
    const ready = await job.wait((r) => r.type === "ready");
    assert.equal(ready.permissions.readOnly, true);
    job.child.stdin.write("not json\n");
    assert.equal((await job.wait((r) => r.command === "parse")).success, false);
    job.send({ id: "first", type: "prompt", message: "FIRST_RPC_CONTEXT" });
    await job.wait((r) => r.id === "first" && r.type === "text");
    job.send({ id: "busy", type: "prompt", message: "Must not start" });
    assert.equal((await job.wait((r) => r.id === "busy")).success, false);
    job.send({ id: "state", type: "get_state" });
    assert.equal((await job.wait((r) => r.id === "state")).data.busy, true);
    job.send({ id: "cancel", type: "abort" });
    const done = await job.wait((r) => r.id === "first" && r.type === "done");
    assert.equal(done.status, "cancelled");
    assert.equal(done.exitCode, 130);
    assert.equal(closed, true);
    slow = false;
    job.send({ id: "second", type: "prompt", message: "Continue" });
    const next = await job.wait((r) => r.id === "second" && r.type === "done");
    assert.equal(next.ok, true);
    assert.equal(next.session, ready.session);
    assert.ok(
      JSON.stringify(f.calls.at(-1).messages).includes("FIRST_RPC_CONTEXT"),
    );
    job.send({ id: "exit", type: "shutdown" });
    assert.equal((await job.done).code, 0);
  },
);

test(
  "piped JSON requests finish after EOF without needing a shutdown command",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const job = await f.start(["headless"], {
      stdin: JSON.stringify({ id: 7, type: "prompt", message: "Explain this" }),
    }).done;
    assert.equal(job.code, 0, job.stderr);
    assert.equal(job.records.at(-1).type, "done");
    assert.equal(job.records.at(-1).id, 7);
  },
);

test(
  "an explicitly pre-approved command runs through the real tool without inheriting API credentials",
  { timeout: 30000 },
  async (t) => {
    const command =
      process.platform === "win32"
        ? "Write-Output 'COMMAND_OK'; if ($env:HERMESDESK_API_KEY) { Write-Output 'ENV_LEAK' }"
        : "printf 'COMMAND_OK\\n'; if [ -n \"$HERMESDESK_API_KEY\" ]; then printf ENV_LEAK; fi";
    const f = await fixture(t, (body, res) =>
      body.messages.some((m) => m.role === "tool")
        ? reply(res)
        : reply(res, {
            tool: {
              name: process.platform === "win32" ? "powershell" : "bash",
              input: { command },
            },
          }),
    );
    const denied = await f.start([
      "run",
      "Run command",
      "--output-format",
      "json",
    ]).done;
    assert.equal(denied.code, 3, denied.stdout + denied.stderr);
    f.calls.length = 0;
    const allowed = await f.start([
      "run",
      "Run command",
      "--approve-commands",
      "--output-format",
      "json",
    ]).done;
    assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
    const toolOutput = JSON.stringify(
      f.calls.at(-1).messages.filter((m) => m.role === "tool"),
    );
    assert.match(toolOutput, /COMMAND_OK/);
    assert.doesNotMatch(toolOutput, /ENV_LEAK/);
  },
);

test(
  "shutdown cancels an active persistent job and oversized protocol lines fail with exit 2",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, (_body, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        'data: {"choices":[{"delta":{"content":"working"},"finish_reason":null}]}\n\n',
      );
    });
    const job = f.start(["headless"]);
    await job.wait((r) => r.type === "ready");
    job.send({ id: "active", type: "prompt", message: "Wait" });
    await job.wait((r) => r.id === "active" && r.type === "text");
    job.send({ type: "shutdown" });
    const stopped = await job.done;
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
    assert.equal(
      stopped.records.find((r) => r.type === "done" && r.id === "active")
        .status,
      "cancelled",
    );
    const oversized = await f.start(["headless"], {
      stdin: "x".repeat(INPUT_LIMIT + 1) + "\n",
    }).done;
    assert.equal(oversized.code, 2, oversized.stdout + oversized.stderr);
    assert.match(oversized.stdout, /limited to 1 MiB/);
  },
);
