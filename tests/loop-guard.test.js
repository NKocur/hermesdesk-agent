import test from "node:test";
import assert from "node:assert/strict";
import { createLoopGuard } from "../src/loop-guard.js";

test("recovery guidance precedes a real stop, and a new run resets it", () => {
  const g = createLoopGuard(),
    input = { path: "source.txt", oldText: "old", newText: "new" };
  assert.equal(g.check("edit", input, "v1"), undefined);
  assert.equal(g.check("edit", input, "v1"), undefined);
  const recovery = g.check("edit", input, "v1");
  assert.equal(recovery.recovery, true);
  assert.match(recovery.reason, /Read the current file/);
  const stopped = g.check("edit", input, "v1");
  assert.equal(stopped.terminate, true);
  assert.equal(g.check("read", { path: "other.txt" }, "v1").terminate, true);
  g.reset();
  assert.equal(g.check("edit", input, "v1"), undefined);
});

test("failed edits survive intervening reads and JSON property reordering", () => {
  const g = createLoopGuard(),
    a = { path: "source.txt", oldText: "old", newText: "new" },
    b = { newText: "new", oldText: "old", path: "source.txt" };
  for (let i = 0; i < 2; i++) {
    assert.equal(g.check("edit", a, "v1"), undefined);
    g.record("edit", a, "v1", true, [
      { type: "text", text: "Exact oldText not found." },
    ]);
    assert.equal(g.check("read", { path: "source.txt" }, "v1"), undefined);
    g.record("read", { path: "source.txt" }, "v1", false);
  }
  const recovery = g.check("edit", b, "v1");
  assert.equal(recovery.recovery, true);
  assert.match(recovery.reason, /Exact oldText not found/);
  g.check("read", { path: "source.txt" }, "v1");
  assert.equal(g.check("edit", a, "v1").terminate, true);
});

test("changed file state and corrected inputs permit a fresh attempt", () => {
  const g = createLoopGuard(),
    input = { path: "source.txt", oldText: "old", newText: "new" };
  for (let i = 0; i < 2; i++) {
    g.check("edit", input, "v1");
    g.record("edit", input, "v1", true);
  }
  assert.equal(g.check("edit", input, "v1").recovery, true);
  assert.equal(g.check("edit", input, "v2"), undefined);
  assert.equal(
    g.check("edit", { ...input, oldText: "current" }, "v1"),
    undefined,
  );
});
