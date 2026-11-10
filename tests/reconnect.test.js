import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRuntime } from "../src/agent.js";
import { runHeadless } from "../src/headless.js";
import { validateConfig } from "../src/config.js";
import { curlFailureDetail } from "../src/transport.js";

function reply(res, { text = "RECOVERED", tool } = {}) {
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
                      id: "write-once",
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({
                          path: "once.txt",
                          content: "one action",
                        }),
                      },
                    },
                  ],
                }
              : { content: text },
            finish_reason: tool ? "tool_calls" : "stop",
          },
        ],
      }) +
      "\n\ndata: [DONE]\n\n",
  );
}
async function fixture(t, handler, options = {}) {
  const home = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "hd-reconnect-"),
    ),
    cwd = path.join(home, "work");
  fs.mkdirSync(cwd);
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (b) => (raw += b));
    req.on("end", () => {
      calls.push(JSON.parse(raw));
      handler(req, res, calls.length, calls);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const runtime = await createRuntime({
    home,
    cwd,
    token: "a".repeat(64),
    approveWrites: !!options.approveWrites,
    config: validateConfig({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: "fixture",
      maxTokens: 128,
      ...options.config,
    }),
  });
  t.after(async () => {
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const records = [];
  const run = (signal) =>
    runHeadless(runtime, "Do the test task", {
      signal,
      onRecord: (e) => records.push(e),
    });
  return { runtime, calls, records, cwd, run };
}

test(
  "two transient connection failures recover before any reply starts",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (req, res, n) =>
      n < 3 ? req.socket.destroy() : reply(res),
    );
    const done = await f.run();
    assert.equal(done.ok, true, done.error);
    assert.equal(f.calls.length, 3);
    assert.equal(
      f.records
        .filter((r) => r.type === "text")
        .map((r) => r.text)
        .join(""),
      "RECOVERED",
    );
    assert.equal(f.records.filter((r) => r.type === "done").length, 1);
  },
);

test(
  "client and authentication errors fail without automatic retry",
  { timeout: 15000 },
  async (t) => {
    for (const status of [400, 401, 403, 413])
      await t.test(String(status), async (sub) => {
        const f = await fixture(sub, (_req, res) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: { message: "FIXTURE_ERROR_" + status } }),
          );
        });
        const done = await f.run();
        assert.equal(done.ok, false);
        assert.equal(f.calls.length, 1);
        assert.match(done.error, new RegExp("FIXTURE_ERROR_" + status));
      });
  },
);

test(
  "a connection drop after streamed output is not replayed",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        'data: {"choices":[{"delta":{"content":"PARTIAL_ONCE"},"finish_reason":null}]}\n\n',
      );
      setTimeout(() => res.destroy(), 100);
    });
    const done = await f.run();
    assert.equal(done.ok, false);
    assert.equal(f.calls.length, 1);
    assert.equal(
      f.records
        .filter((r) => r.type === "text")
        .map((r) => r.text)
        .join(""),
      "PARTIAL_ONCE",
    );
  },
);

test(
  "completed tool actions survive a retry and are executed once",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      (req, res, n) =>
        n === 1
          ? reply(res, { tool: true })
          : n === 2
            ? req.socket.destroy()
            : reply(res),
      { approveWrites: true },
    );
    const done = await f.run();
    assert.equal(done.ok, true, done.error);
    assert.equal(f.calls.length, 3);
    assert.equal(f.records.filter((r) => r.type === "tool").length, 1);
    assert.equal(
      fs.readFileSync(path.join(f.cwd, "once.txt"), "utf8"),
      "one action",
    );
    assert.ok(
      f.calls[2].messages.some(
        (m) => m.role === "tool" && m.tool_call_id === "write-once",
      ),
    );
  },
);

test(
  "cancellation during reconnect backoff prevents further attempts",
  { timeout: 15000 },
  async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, (req) => {
      req.socket.destroy();
      setTimeout(() => controller.abort(), 25);
    });
    const done = await f.run(controller.signal);
    assert.equal(done.status, "cancelled");
    assert.equal(done.exitCode, 130);
    assert.equal(f.calls.length, 1);
  },
);

test(
  "exhausted retries preserve the underlying connection diagnostic",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (req) => req.socket.destroy());
    const done = await f.run();
    assert.equal(done.ok, false);
    assert.equal(f.calls.length, 3);
    assert.match(done.error, /3 connection attempts/);
    assert.match(
      done.error,
      process.platform === "win32" ? /curl/i : /socket hang up|ECONNRESET/i,
    );
  },
);

test("curl diagnostics redact access credentials before truncation and output", () => {
  const token = "s".repeat(64),
    secret = "z".repeat(64),
    id = "private-client-id";
  const r = new Request("https://example.test/v1/models", {
    headers: {
      authorization: "Bearer " + token,
      "cf-access-client-secret": secret,
      "cf-access-client-id": id,
    },
  });
  const detail = curlFailureDetail(
    `curl: (56) connection reset\nBearer ${token} ${token} ${secret} ${id}\n` +
      "x".repeat(5000),
    r,
  );
  for (const credential of [token, secret, id])
    assert.ok(!detail.includes(credential));
  assert.match(detail, /connection reset/);
  assert.ok(detail.length <= 600);
  assert.ok(!detail.includes("\n"));
});
