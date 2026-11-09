import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { policyExtension } from "../src/policy.js";
import {
  approvalText,
  displayPath,
  editStats,
  limitText,
  thinkingText,
} from "../src/ui/format.js";
import { fitSegments, spread } from "../src/ui/layout.js";
import { footerFactory, headerFactory } from "../src/ui/chrome.js";
import { ApprovalDialog, requestApproval } from "../src/ui/approval.js";
import { chooseItem } from "../src/ui/menu.js";
import { toolRenderer } from "../src/ui/tools.js";
import { runInterrupt } from "../src/ui/interrupt.js";
import { THEME_DIR, themeSetting } from "../src/ui/extension.js";
import { currentProfile, generationSummary } from "../src/commands.js";
import { PROFILES } from "../src/generation.js";
import { validateConfig } from "../src/config.js";

// A theme stand-in that marks styling with brackets, so tests can see it without ANSI.
const theme = {
  fg: (color, text) => `\x1b[3${color.length % 8}m${text}\x1b[39m`,
  bg: (_color, text) => text,
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

test("formatting helpers describe limits, thinking, paths and edits compactly", () => {
  assert.equal(limitText(65536), "64K");
  assert.equal(limitText(131072), "128K");
  assert.equal(limitText(5000), "5,000");
  assert.equal(limitText(0), "auto");
  assert.equal(thinkingText({ ...config, thinking: false }), "off");
  assert.equal(thinkingText({ ...config, thinkingBudget: 8192 }), "xhigh ≤8K");
  const home = path.join(os.tmpdir(), "hd-home");
  assert.equal(displayPath(home, 40, home), "~");
  const deep = path.join(home, "a", "very", "long", "nested", "project");
  const short = displayPath(deep, 18, home);
  assert.ok(short.length <= 18 && short.endsWith("project"), short);
  assert.deepEqual(
    editStats([{ oldText: "a\nb\nc", newText: "a\nB\nB2\nc" }]),
    { added: 2, removed: 1 },
  );
  const text = approvalText("edit", {
    path: "x.js",
    edits: [{ oldText: "old", newText: "new" }],
  });
  assert.match(text, /x\.js {2}\(\+1 −1\)/);
  assert.doesNotMatch(text, /oldText|\{"/, "no raw JSON in approvals");
  assert.match(
    approvalText("write", { path: "a", content: "1\n2\n" }),
    /2 lines/,
  );
});

test("layout keeps every line within the terminal width", () => {
  for (const width of [12, 40, 100])
    assert.ok(
      visibleWidth(spread("left side text", "right side", width)) <= width,
    );
  assert.equal(fitSegments(["one", "two", "three"], 9, " · "), "one · two");
  const header = headerFactory({
    version: "1.0",
    mode: { short: "asks first" },
  })(null, theme);
  const footer = footerFactory({
    getContext: () => ({
      model: { id: "strata-test" },
      sessionManager: {
        getCwd: () => process.cwd(),
        getEntries: () => [
          {
            type: "message",
            message: { role: "assistant", usage: { input: 1500, output: 300 } },
          },
        ],
        getSessionId: () => "s",
        getLeafId: () => "l",
      },
      getContextUsage: () => ({ contextWindow: 262144, percent: 12.5 }),
    }),
    read: () => config,
    mode: { tone: "accent", short: "asks first" },
  })({ requestRender() {} }, theme, {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map(),
  });
  for (const width of [30, 58, 100, 160]) {
    assert.ok(fitsWidth(header.render(width), width), "header " + width);
    const lines = footer.render(width);
    assert.equal(lines.length, 2);
    assert.ok(fitsWidth(lines, width), "footer " + width);
  }
  const wide = footer.render(120).map(plain).join("\n");
  for (const part of [
    "strata-test",
    "think xhigh",
    "64K out",
    "main",
    "asks first",
    "ctx 13% of 256K",
    "↑1.5k ↓300",
  ])
    assert.ok(wide.includes(part), part);
  // Narrow terminals keep the safety mode and context fill.
  const narrow = footer.render(40).map(plain).join("\n");
  assert.ok(narrow.includes("asks first") && narrow.includes("ctx 13%"));
});

test("approval dialog allows only explicit approval; escape, n and cancel deny", async () => {
  const request = {
    tone: "warning",
    title: "Run command",
    subject: "PowerShell",
    body: () => Array.from({ length: 40 }, (_, i) => "line " + i),
  };
  const press = (...keys) => {
    let result = "pending";
    const dialog = new ApprovalDialog(
      { terminal: { rows: 30 }, requestRender() {} },
      theme,
      undefined,
      request,
      (value) => (result = value),
    );
    assert.ok(fitsWidth(dialog.render(50), 50));
    for (const key of keys) dialog.handleInput(key);
    return { result, dialog };
  };
  assert.equal(press("y").result, true);
  assert.equal(press("n").result, false);
  assert.equal(press("\x1b").result, false);
  assert.equal(press("\r").result, true, "Allow once is preselected");
  assert.equal(press("\x1b[B", "\r").result, false);
  assert.equal(press("x").result, "pending", "other keys do nothing");
  const { dialog } = press("\x1b[6~");
  assert.match(dialog.render(60).map(plain).join("\n"), /lines \d+–\d+ of 40/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-ui-"));
  try {
    const run = async (answer) => {
      const handlers = {};
      policyExtension({ root })({ on: (name, f) => (handlers[name] = f) });
      return handlers.tool_call(
        { toolName: "write", input: { path: "x.txt", content: "x" } },
        { hasUI: true, mode: "tui", ui: { custom: async () => answer } },
      );
    };
    assert.equal(await run(true), undefined);
    for (const answer of [false, undefined, "yes"])
      assert.equal((await run(answer)).block, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // Non-TUI hosts keep the plain confirm with readable details.
  let seen;
  const allowed = await requestApproval(
    {
      hasUI: true,
      ui: {
        confirm: async (title, detail) => {
          seen = { title, detail };
          return true;
        },
      },
    },
    "powershell",
    { command: "Get-ChildItem" },
  );
  assert.equal(allowed, true);
  assert.equal(seen.title, "Approve shell command?");
  assert.match(seen.detail, /without an OS sandbox[\s\S]*Get-ChildItem/);
});

test("menus return stable values in both interactive and plain hosts", async () => {
  const items = [
    { value: "fast", label: "fast", description: "32K" },
    { value: "balanced", label: "balanced", current: true },
  ];
  const plainHost = {
    hasUI: true,
    ui: { select: async (_t, values) => values[1] },
  };
  assert.equal(
    await chooseItem(plainHost, { title: "Pick", items }),
    "balanced",
  );
  let rendered;
  const tuiHost = {
    hasUI: true,
    mode: "tui",
    ui: {
      custom: async (factory) =>
        new Promise((resolve) => {
          const component = factory(
            { requestRender() {} },
            theme,
            undefined,
            resolve,
          );
          rendered = component.render(48);
          component.handleInput("\r");
        }),
    },
  };
  assert.equal(await chooseItem(tuiHost, { title: "Pick", items }), "balanced");
  assert.ok(fitsWidth(rendered, 48));
  assert.match(rendered.map(plain).join("\n"), /Pick[\s\S]*● balanced/);
  assert.equal(currentProfile({ ...config, ...PROFILES.balanced }), "balanced");
  assert.equal(currentProfile({ ...config, maxTokens: 1000 }), undefined);
  assert.match(
    generationSummary(config),
    /^Generation settings\nOutput {4}65,536/,
  );
});

test("tool rows wrap Pi renderers with a status glyph and no panel padding", () => {
  const box = {
    bg: "set",
    setBgFn(fn) {
      this.bg = fn("x");
    },
    render: () => ["", "  edit src/a.js", "", "  +1 new line", ""],
  };
  const renderers = toolRenderer("edit", () => ({
    renderCall: () => box,
    renderResult: () => ({ render: () => ["Applied"] }),
  }));
  assert.equal(renderers.renderShell, "self");
  const context = (extra) => ({
    executionStarted: true,
    isPartial: false,
    isError: false,
    durationMs: 50,
    keyHint: () => "",
    ...extra,
  });
  const done = renderers.renderCall({}, theme, context()).render(40).map(plain);
  assert.deepEqual(done, [" ✓ edit src/a.js", " │ ", " │ +1 new line"]);
  assert.equal(box.bg, "x", "Pi's tinted panel is neutralised");
  const pending = renderers
    .renderCall({}, theme, context({ isPartial: true }))
    .render(40)
    .map(plain);
  assert.deepEqual(
    pending,
    [" ● edit src/a.js"],
    "diff waits for the approval dialog",
  );
  const refused = renderers
    .renderCall({}, theme, context({ isError: true }))
    .render(40)
    .map(plain);
  assert.deepEqual(refused, [" ✗ edit src/a.js"]);
  assert.deepEqual(
    renderers.renderResult({}, {}, theme, context()).render(40).map(plain),
    [" │ Applied"],
  );
  assert.equal(
    toolRenderer("other", () => "builtin"),
    "builtin",
  );
  const search = toolRenderer("search", () => undefined);
  const lines = search
    .renderResult(
      { content: [{ type: "text", text: "src/a.js:3: hit\nsrc/b.js:9: hit" }] },
      { expanded: false },
      theme,
      context(),
    )
    .render(60)
    .map(plain);
  assert.equal(lines[0].trimEnd(), " │ 2 matches in 2 files");
});

test("HermesDesk themes are complete, valid pairs selected by HERMESDESK_THEME", () => {
  const dark = JSON.parse(
    fs.readFileSync(path.join(THEME_DIR, "hermesdesk-dark.json"), "utf8"),
  );
  const light = JSON.parse(
    fs.readFileSync(path.join(THEME_DIR, "hermesdesk-light.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(light.colors).sort(),
    Object.keys(dark.colors).sort(),
  );
  assert.equal(dark.appearance, "dark");
  assert.equal(light.appearance, "light");
  assert.equal(dark.colors.text, "", "body text uses the terminal's own color");
  assert.equal(themeSetting(undefined), "hermesdesk-light/hermesdesk-dark");
  assert.equal(themeSetting("Light"), "hermesdesk-light");
  assert.equal(themeSetting("dark"), "hermesdesk-dark");
  assert.equal(themeSetting("terminal"), "system");
  assert.equal(themeSetting("nonsense"), "hermesdesk-light/hermesdesk-dark");
});

test("failed search output preserves its actual error rather than saying no matches", () => {
  const search = toolRenderer("search", () => undefined);
  const context = { isError: true, keyHint: () => "" };
  const error = "Search failed: directory does not exist";
  const lines = search
    .renderResult(
      { content: [{ type: "text", text: error }] },
      { expanded: false },
      theme,
      context,
    )
    .render(80)
    .map(plain)
    .join("\n");
  assert.match(lines, /directory does not exist/);
  assert.doesNotMatch(lines, /No matches/);
  const empty = search
    .renderResult(
      { content: [{ type: "text", text: "No matches." }] },
      { expanded: false },
      theme,
      { ...context, isError: false },
    )
    .render(80)
    .map(plain)
    .join("\n");
  assert.match(empty, /No matches/);
});

test("Ctrl+C interrupts active work without invoking idle clear/exit", () => {
  let idle = false,
    calls = 0;
  const handle = runInterrupt({ isIdle: () => idle, abort: () => calls++ });
  assert.equal(handle("c"), undefined);
  assert.equal(handle("\x1b"), undefined);
  assert.equal(handle("\x1b[200~pasted\x03text\x1b[201~"), undefined);
  assert.equal(calls, 0);
  assert.deepEqual(handle("\x03"), { consume: true });
  assert.deepEqual(handle("\x03"), { consume: true });
  assert.equal(calls, 2);
  idle = true;
  assert.equal(handle("\x03"), undefined);
  assert.equal(calls, 2, "idle Ctrl+C remains Pi's clear/exit shortcut");
});

test("aborting a run dismisses an outstanding approval without allowing it", () => {
  const controller = new AbortController();
  const answers = [];
  const dialog = new ApprovalDialog(
    {},
    theme,
    undefined,
    { body: () => [] },
    (value) => answers.push(value),
    controller.signal,
  );
  controller.abort();
  assert.deepEqual(answers, [false]);
  dialog.dispose();
  const alreadyAborted = [];
  const second = new ApprovalDialog(
    {},
    theme,
    undefined,
    { body: () => [] },
    (value) => alreadyAborted.push(value),
    controller.signal,
  );
  assert.deepEqual(alreadyAborted, [false]);
  second.dispose();
  const completed = new AbortController();
  const disposed = new ApprovalDialog(
    {},
    theme,
    undefined,
    { body: () => [] },
    () => assert.fail("closed dialog must not be called again"),
    completed.signal,
  );
  disposed.dispose();
  completed.abort();
});
