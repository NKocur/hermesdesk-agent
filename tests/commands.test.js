import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generationCommands, tokenValue } from "../src/commands.js";
import { loadConfig, saveConfig, validateConfig } from "../src/config.js";
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesdesk-commands-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let config = saveConfig(
      { baseUrl: "https://first.example/v1", model: "fixture" },
      home,
    ),
    busy = false,
    updates = 0;
  const commands = new Map(),
    events = new Map(),
    notices = [],
    choices = [],
    inputs = [];
  const ctx = {
    hasUI: true,
    isIdle: () => !busy,
    ui: {
      notify: (text, type) => notices.push({ text, type }),
      setStatus() {},
      select: async () => choices.shift(),
      input: async () => inputs.shift(),
    },
  };
  generationCommands({
    home,
    read: () => ({ ...config }),
    apply: async (next) => {
      config = next;
      updates++;
    },
  })({
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, f) => events.set(name, f),
  });
  return {
    home,
    commands,
    ctx,
    notices,
    choices,
    inputs,
    get: () => config,
    updates: () => updates,
    busy: (value) => (busy = value),
    run: (name, args = "") => commands.get(name).handler(args, ctx),
  };
}
test("direct commands change only the current generation settings; defaults save explicitly", async (t) => {
  const f = fixture(t),
    original = loadConfig(f.home);
  await f.run("profile", "extended");
  assert.equal(f.get().maxTokens, 131072);
  assert.equal(f.get().thinking, true);
  assert.equal(f.get().temperature, 1);
  await f.run("tokens", "64k");
  await f.run("thinking-budget", "8192");
  await f.run("think", "medium");
  assert.equal(f.get().maxTokens, 65536);
  assert.equal(f.get().reasoningEffort, "medium");
  assert.equal(f.get().thinkingBudget, 8192);
  assert.deepEqual(loadConfig(f.home), original);
  saveConfig(
    {
      ...original,
      baseUrl: "https://second.example/v1",
      model: "different-model",
    },
    f.home,
  );
  await f.run("limits", "save");
  const saved = loadConfig(f.home);
  assert.equal(saved.baseUrl, "https://second.example/v1");
  assert.equal(saved.model, "different-model");
  assert.equal(saved.maxTokens, 65536);
  assert.equal(saved.reasoningEffort, "medium");
  await f.run("profile", "fast");
  await f.run("limits", "reset");
  assert.equal(f.get().maxTokens, 65536);
  assert.equal(f.get().reasoningEffort, "medium");
  assert.ok(
    !f.commands.has("thinking"),
    "Pi's native /thinking remains available",
  );
});
test("busy, invalid and cancelled commands do not change settings or saved defaults", async (t) => {
  const f = fixture(t),
    original = loadConfig(f.home);
  f.busy(true);
  await f.run("profile", "fast");
  assert.equal(f.updates(), 0);
  assert.match(f.notices.at(-1).text, /Wait/);
  f.busy(false);
  for (const [name, args] of [
    ["tokens", "131073"],
    ["tokens", "1.5k"],
    ["tokens", "NaN"],
    ["thinking-budget", "131072"],
    ["think", "wrong"],
    ["profile", "wrong"],
    ["limits", "wrong"],
  ])
    await f.run(name, args);
  assert.equal(f.updates(), 0);
  assert.deepEqual(loadConfig(f.home), original);
  await f.run("limits");
  await f.run("profile");
  await f.run("tokens");
  await f.run("thinking-budget");
  assert.equal(f.updates(), 0);
});
test("the limits menu edits controls and supports automatic thinking budget and completion", async (t) => {
  const f = fixture(t);
  f.choices.push("Choose profile", "balanced");
  await f.run("limits");
  assert.equal(f.get().maxTokens, 65536);
  f.choices.push("Thinking: xhigh", "off");
  await f.run("limits");
  assert.equal(f.get().thinking, false);
  f.choices.push("Total output: 65,536");
  f.inputs.push("128k");
  await f.run("limits");
  assert.equal(f.get().maxTokens, 131072);
  await f.run("thinking-budget", "4k");
  assert.equal(f.get().thinkingBudget, 4096);
  await f.run("thinking-budget", "auto");
  assert.equal(f.get().thinkingBudget, 0);
  assert.equal(tokenValue("32k"), 32768);
  assert.equal(tokenValue("auto", true), 0);
  assert.deepEqual(
    f.commands
      .get("profile")
      .getArgumentCompletions("ex")
      .map((x) => x.value),
    ["extended"],
  );
});
