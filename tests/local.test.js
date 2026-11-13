// Behavior added for locally hosted models: wait and speed feedback, /status, limit notices,
// and the repeated-call guard.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { policyExtension } from "../src/policy.js";
import { validateConfig } from "../src/config.js";
import { createActivity, durationText, rateText } from "../src/ui/activity.js";
import { footerFactory, headerFactory } from "../src/ui/chrome.js";
import { interfaceExtension, truncationNotice } from "../src/ui/extension.js";
import { friendlyError } from "../src/ui/format.js";
import { meter } from "../src/ui/layout.js";
import { probeServer, statusText } from "../src/ui/status.js";

const theme = {
  fg: (color, text) => `\x1b[3${color.length % 8}m${text}\x1b[39m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
const fitsWidth = (lines, width) =>
  lines.every((line) => visibleWidth(line) <= width);
const config = validateConfig({
  baseUrl: "https://example.test/v1",
  model: "strata-test",
  maxTokens: 65536,
  thinking: true,
  reasoningEffort: "xhigh",
});

test("activity describes the wait, the phase and the speed of a local model", () => {
  let at = 0;
  const activity = createActivity(() => at);
  assert.equal(activity.label(), undefined, "idle keeps the default label");
  activity.runStart();
  assert.equal(activity.label(), "Working");
  activity.requestStart();
  assert.equal(activity.label(), "Waiting for model");
  at = 5000;
  assert.equal(activity.label(), "Waiting for model · 5s");
  at = 20000;
  assert.match(activity.label(), /· 20s · processing the prompt$/);
  at = 65000;
  assert.match(activity.label(), /· 1m 05s · the model may still be loading$/);
  assert.equal(activity.delta("thinking", "x".repeat(40)), true);
  assert.equal(activity.delta("thinking", "x".repeat(40)), false);
  assert.equal(activity.label(), "Thinking");
  at = 69000;
  activity.delta("thinking", "x".repeat(320));
  assert.equal(activity.label(), "Thinking · 4s · ~25 tok/s");
  assert.equal(activity.delta("writing", "x".repeat(400)), true);
  at = 85000;
  assert.equal(activity.label(), "Writing · 16s · no output for 16s");
  assert.equal(activity.delta("calling", "{", "edit"), true);
  assert.equal(activity.label(), "Preparing edit · ~10 tok/s");
  activity.requestEnd({ output: 400 });
  assert.deepEqual(activity.last, {
    waitMs: 65000,
    ms: 20000,
    tokens: 400,
    estimated: false,
    rate: 20,
  });
  activity.toolStart("powershell");
  at = 88000;
  assert.equal(activity.label(), "Running command · 3s");
  activity.toolEnd();
  // Without a server token count the estimate is kept and marked.
  activity.requestStart();
  activity.delta("writing", "x".repeat(800));
  at = 92000;
  activity.requestEnd(undefined);
  assert.equal(activity.last.estimated, true);
  assert.equal(activity.last.tokens, 200);
  assert.deepEqual(activity.average, { replies: 2, rate: 25, estimated: true });
  // A request that fails before any output leaves the last measurement alone.
  activity.requestStart();
  activity.requestEnd(undefined);
  assert.equal(activity.last.tokens, 200);
  assert.equal(activity.runEnd(), 92000);
  assert.equal(activity.label(), undefined);
  assert.equal(durationText(4230), "4.2s");
  assert.equal(durationText(75000), "1m 15s");
  assert.equal(rateText(7.26), "7.3 tok/s");
});

test("header names the model and server; footer adds speed and a context bar", () => {
  const read = () => config;
  const header = headerFactory({
    version: "1.0",
    mode: { short: "asks first" },
    read,
  })(null, theme);
  const top = header.render(100).map(plain);
  assert.match(top[0], /HermesDesk Agent 1\.0 +strata-test on example\.test $/);
  assert.ok(top.join("\n").includes("/status"));
  assert.ok(fitsWidth(header.render(34), 34));
  const footer = footerFactory({
    getContext: () => ({
      sessionManager: {
        getCwd: () => process.cwd(),
        getEntries: () => [{ type: "usage", usage: { input: 9, output: 1 } }],
      },
      getContextUsage: () => ({ contextWindow: 262144, percent: 50 }),
    }),
    read,
    mode: { tone: "accent", short: "asks first" },
    activity: { last: { rate: 37.6 } },
  })({ requestRender() {} }, theme, {});
  assert.match(
    plain(footer.render(120)[1]),
    /↑9 ↓1 · 38 tok\/s · ━{8} ctx 50% of 256K $/,
  );
  for (const width of [24, 44, 60])
    assert.ok(fitsWidth(footer.render(width), width));
  assert.ok(plain(footer.render(36)[1]).includes("ctx 50%"));
  assert.equal(plain(meter(theme, 0, 8)), "━".repeat(8));
  assert.equal(meter(theme, 1, 8), meter(theme, 12, 8), "small fills show");
  assert.notEqual(meter(theme, 0, 8), meter(theme, 1, 8));
});

test("status reports the server, context and speed, and marks an unreachable server", async () => {
  const activity = {
    last: { waitMs: 4200, ms: 31000, tokens: 1204, rate: 38.8 },
    average: { replies: 3, rate: 36 },
  };
  let at = 0;
  const probe = await probeServer(
    async () => ((at = 240), ["strata-test"]),
    "strata-test",
    () => at,
  );
  assert.deepEqual(probe, { ok: true, ms: 240, available: true });
  const text = statusText({
    config,
    mode: { long: "Edits and commands ask first" },
    probe,
    context: { tokens: 34512, contextWindow: 262144, percent: 13.2 },
    tokens: { input: 120000, output: 14000 },
    activity,
  });
  assert.deepEqual(text.split("\n"), [
    "Status",
    "Server     example.test · reachable, answered in 240 ms",
    "Model      strata-test · available",
    "Context    35k of 256K tokens (13%)",
    "Last reply 39 tok/s · first token after 4.2s · 1,204 tokens in 31s",
    "Session    36 tok/s average over 3 replies · ↑120k ↓14k tokens",
    "Safety     Edits and commands ask first",
  ]);
  const down = await probeServer(async () => {
    throw Error("Windows HTTP transport failed.");
  }, "strata-test");
  assert.equal(down.ok, false);
  const offline = statusText({
    config,
    mode: { long: "Read-only" },
    probe: down,
    context: { tokens: null, contextWindow: 262144, percent: null },
  });
  assert.match(offline, /not reachable: Windows HTTP transport failed\./);
  assert.match(offline, /Context {4}not measured yet/);
  assert.doesNotMatch(offline, /Last reply|Session/);
});

test("the interface extension drives the working line, title, notices and /status", async () => {
  const handlers = {},
    commands = {};
  let at = 0,
    bells = 0;
  interfaceExtension({
    version: "1.0",
    read: () => config,
    discover: async () => ["strata-test"],
    activity: createActivity(() => at),
    bell: () => bells++,
  })({
    on: (name, handler) => (handlers[name] = handler),
    registerToolRenderer() {},
    registerCommand: (name, options) => (commands[name] = options),
  });
  const working = [],
    titles = [],
    notices = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: path.join("x", "my-project"),
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ tokens: 10, contextWindow: 262144, percent: 0 }),
    ui: {
      setWorkingMessage: (text) => working.push(text),
      setTitle: (text) => titles.push(text),
      notify: (text, type) => notices.push([type, text]),
    },
  };
  const update = (type, extra) =>
    handlers.message_update({ assistantMessageEvent: { type, ...extra } }, ctx);
  handlers.agent_start({}, ctx);
  handlers.before_provider_request({}, ctx);
  update("start");
  update("thinking_delta", { delta: "hm" });
  update("thinking_delta", { delta: "hm" });
  update("toolcall_start", {
    contentIndex: 1,
    partial: { content: [{}, { name: "write" }] },
  });
  at = 40000;
  assert.equal(
    handlers.message_end(
      {
        message: {
          role: "assistant",
          stopReason: "toolUse",
          usage: { output: 900 },
        },
      },
      ctx,
    ),
    undefined,
  );
  handlers.tool_call({ toolName: "write" }, ctx);
  handlers.tool_execution_end({}, ctx);
  assert.deepEqual(working, [
    "Working",
    "Waiting for model",
    "Thinking",
    "Preparing write",
    "Working",
    "Writing file",
    "Working",
  ]);
  // Output-limit stops say what to change; gateway HTML never reaches the transcript.
  handlers.message_end(
    {
      message: {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "thinking", thinking: "…" }],
      },
    },
    ctx,
  );
  assert.equal(notices[0][0], "warning");
  assert.match(notices[0][1], /Thinking used the whole 64K output limit/);
  assert.match(
    truncationNotice({ content: [{ type: "text", text: "partial" }] }, config),
    /reached the 64K output limit.*\/tokens/,
  );
  const replaced = handlers.message_end(
    {
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "<!DOCTYPE html><html>Just a moment</html>",
      },
    },
    ctx,
  );
  assert.equal(replaced.message.role, "assistant");
  assert.match(replaced.message.errorMessage, /^Cloudflare rejected/);
  assert.equal(friendlyError("x".repeat(2000)).length, 1200);
  handlers.agent_settled({}, ctx);
  assert.deepEqual(titles, [
    "● my-project · HermesDesk",
    "my-project · HermesDesk",
  ]);
  assert.equal(working.at(-1), undefined, "the default label returns");
  assert.equal(bells, 1, "a 40 s run rings the bell when it is enabled");
  handlers.agent_start({}, ctx);
  handlers.agent_settled({}, ctx);
  assert.equal(bells, 1, "short runs stay silent");
  await commands.status.handler("", ctx);
  assert.equal(notices.at(-1)[0], "info");
  assert.match(
    notices.at(-1)[1],
    /^Status\nServer {5}example\.test · reachable/,
  );
  // One-shot runs have no working line or title to drive.
  handlers.agent_start({}, { hasUI: false, mode: "print" });
  handlers.agent_settled({}, { hasUI: false, mode: "print" });
});

test("a third identical tool call in a row is refused before any approval prompt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-loop-"));
  try {
    const handlers = {};
    let prompts = 0;
    policyExtension({ root })({ on: (name, f) => (handlers[name] = f) });
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { custom: async () => (prompts++, false) },
    };
    const call = (input, toolName = "read") =>
      handlers.tool_call({ toolName, input }, ctx);
    assert.equal(await call({ path: "a.txt" }), undefined);
    assert.equal(await call({ path: "a.txt" }), undefined, "one retry is fine");
    const third = await call({ path: "a.txt" });
    assert.equal(third.block, true);
    assert.match(third.reason, /Repeated unchanged read/);
    const stopped = await call({ path: "a.txt" });
    assert.equal(stopped.terminate, true);
    assert.match(stopped.reason, /Stopped a repeated-tool loop/);
    handlers.agent_start();
    assert.equal(await call({ path: "b.txt" }), undefined, "a new call resets");
    assert.equal(await call({ path: "a.txt" }), undefined);
    const shell = { command: "npm test" };
    await call(shell, "powershell");
    await call(shell, "powershell");
    assert.match(
      (await call(shell, "powershell")).reason,
      /Repeated unchanged powershell/,
    );
    assert.equal(prompts, 2, "the refused repeat never asks for approval");
    handlers.agent_start();
    assert.match(
      (await call(shell, "powershell")).reason,
      /declined/,
      "each new message starts fresh",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("telemetry records a first token at clock zero and labels estimated speeds", () => {
  let at = 0;
  const activity = createActivity(() => at);
  activity.runStart();
  activity.requestStart();
  activity.delta("writing", "x".repeat(400));
  at = 2000;
  activity.requestEnd(undefined);
  assert.equal(activity.last.tokens, 100);
  assert.equal(activity.last.waitMs, 0);
  assert.equal(activity.last.rate, 50);
  assert.equal(activity.last.estimated, true);
  const text = statusText({
    config,
    mode: { long: "Read-only" },
    probe: { ok: true, available: true, ms: 10 },
    activity,
  });
  assert.match(text, /Last reply ~50 tok\/s/);
  assert.match(text, /Session +~50 tok\/s average/);
  const footer = footerFactory({
    getContext: () => undefined,
    read: () => config,
    mode: { tone: "accent", short: "asks first" },
    activity,
  })({ requestRender() {} }, theme, {});
  assert.match(plain(footer.render(150)[1]), /~50 tok\/s/);
  activity.requestStart();
  activity.delta("writing", "x".repeat(400));
  at = 4000;
  activity.requestEnd({ output: 160 });
  assert.equal(activity.last.rate, 80);
  assert.equal(activity.last.estimated, false);
  assert.doesNotMatch(plain(footer.render(150)[1]), /~80 tok\/s/);
});
