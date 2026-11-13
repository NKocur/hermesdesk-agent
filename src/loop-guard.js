import crypto from "node:crypto";

// Count unchanged failures, not total requests. A productive job has no ceiling.
const LIMIT = 2;
const HISTORY = 32;
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;

export function createLoopGuard() {
  let lastKey,
    repeats = 0,
    stopped;
  const history = new Map();
  const keyFor = (name, input, version) =>
    name +
    ":" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify([canonical(input), version ?? null]))
      .digest("hex");
  const entry = (key) => {
    if (!history.has(key)) {
      if (history.size >= HISTORY) history.delete(history.keys().next().value);
      history.set(key, { failures: 0, warned: false, error: "" });
    }
    return history.get(key);
  };
  return {
    reset() {
      lastKey = undefined;
      repeats = 0;
      stopped = undefined;
      history.clear();
    },
    check(name, input, version) {
      if (stopped) return { reason: stopped, terminate: true };
      const key = keyFor(name, input, version);
      repeats = key === lastKey ? repeats + 1 : 0;
      lastKey = key;
      const previous = history.get(key);
      if (repeats < LIMIT && (previous?.failures || 0) < LIMIT) return;
      const item = entry(key),
        label = name + (input.path ? " " + input.path : "");
      const detail = item.error ? "\nLast tool error: " + item.error : "";
      const recovery =
        name === "edit"
          ? "Read the current file with read, copy oldText exactly from its current contents (including whitespace), then submit a corrected edit. If the edit was already applied, verify the file instead. Do not resend these unchanged arguments."
          : "Use the earlier result and choose a different step or correct the arguments. Do not resend this unchanged call.";
      if (!item.warned) {
        item.warned = true;
        return {
          reason:
            "Repeated unchanged " +
            label +
            " call." +
            detail +
            "\nRecovery: " +
            recovery,
          recovery: true,
        };
      }
      stopped =
        "Stopped a repeated-tool loop for " +
        label +
        ": the same unchanged call continued after recovery guidance." +
        detail +
        "\nConversation and completed changes are preserved. " +
        recovery;
      return { reason: stopped, terminate: true };
    },
    record(name, input, version, isError, content = []) {
      const key = keyFor(name, input, version);
      if (!isError) {
        history.delete(key);
        return;
      }
      const item = entry(key);
      item.failures++;
      item.error = content
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("\n")
        .slice(0, 1000);
    },
  };
}
