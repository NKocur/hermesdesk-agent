import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateConfig, loadConfig } from "../src/config.js";
import { profile, generationPayload } from "../src/generation.js";

test("extended budgets validate against context and thinking caps without resetting legacy values", () => {
  const c = validateConfig({ ...profile("extended"), thinkingBudget: 16384 });
  assert.equal(c.maxTokens, 131072);
  assert.equal(generationPayload(c).reasoning_effort, "xhigh");
  assert.equal(validateConfig({ maxTokens: 8192 }).maxTokens, 8192);
  assert.equal(validateConfig({}).maxTokens, 131072);
  for (const input of [
    { maxTokens: 131073 },
    { reasoningEffort: "wrong" },
    { thinkingBudget: -1 },
    { maxTokens: 8192, thinkingBudget: 8192 },
    { maxTokens: 131072, context: 131072 },
  ])
    assert.throws(() => validateConfig(input));
  assert.throws(() => profile("wrong"));
  const off = generationPayload(
    validateConfig({ thinking: false, thinkingBudget: 4096 }),
  );
  assert.equal(off.reasoning_effort, "none");
  assert.equal(off.reasoning_budget_tokens, 0);
});

test("CLI config presets and effort/budget commands persist the selected profile", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermesdesk-limits-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cli = path.resolve("bin/hermesdesk.js");
  const run = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, "config", ...args], {
        env: { ...process.env, HERMESDESK_AGENT_HOME: home },
        encoding: "utf8",
      }),
    );
  assert.equal(run(["preset", "extended"]).maxTokens, 131072);
  assert.equal(
    run(["set", "reasoningEffort", "medium"]).reasoningEffort,
    "medium",
  );
  assert.equal(run(["set", "thinkingBudget", "8192"]).thinkingBudget, 8192);
  assert.equal(loadConfig(home).thinking, true);
  assert.equal(run(["preset", "fast"]).thinking, false);
});
