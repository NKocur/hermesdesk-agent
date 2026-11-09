// Pure text helpers shared by the HermesDesk terminal UI. They never emit ANSI themselves.
import path from "node:path";

export const BRAND = "HermesDesk Agent";

/** Token limits: whole binary K values read as "64K"; other values keep full digits. */
export function limitText(value) {
  if (!value) return "auto";
  return value >= 1024 && value % 1024 === 0
    ? `${value / 1024}K`
    : value.toLocaleString("en-US");
}

/** Usage counters: compact decimal form, matching Pi's footer. */
export function countText(value = 0) {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

export function thinkingText(config) {
  if (!config.thinking) return "off";
  return config.thinkingBudget
    ? `${config.reasoningEffort} ≤${limitText(config.thinkingBudget)}`
    : config.reasoningEffort;
}

export function approvalMode({ readOnly, approveWrites }) {
  if (readOnly)
    return { tone: "warning", short: "read-only", long: "Read-only" };
  if (approveWrites)
    return {
      tone: "warning",
      short: "edits auto-approved",
      long: "Edits auto-approved, commands ask",
    };
  return {
    tone: "accent",
    short: "asks first",
    long: "Edits and commands ask first",
  };
}

/** Shorten a directory for display: home becomes ~, and long paths keep their last segments. */
export function displayPath(
  dir,
  max = 48,
  home = process.env.USERPROFILE || process.env.HOME,
) {
  let text = dir;
  if (home) {
    const rel = path.relative(home, dir);
    if (rel === "") text = "~";
    else if (!rel.startsWith("..") && !path.isAbsolute(rel))
      text = "~" + path.sep + rel;
  }
  if (text.length <= max) return text;
  const parts = text.split(/[\\/]/);
  let out = parts.at(-1);
  for (let i = parts.length - 2; i > 0; i--) {
    const next = parts[i] + path.sep + out;
    if (next.length + 2 > max) break;
    out = next;
  }
  out = "…" + path.sep + out;
  return out.length <= max ? out : "…" + out.slice(out.length - max + 1);
}

/** Count added and removed lines across exact-replacement edits. */
export function editStats(edits = []) {
  let added = 0,
    removed = 0;
  for (const edit of edits) {
    const before = String(edit?.oldText ?? "").split("\n"),
      after = String(edit?.newText ?? "").split("\n");
    let start = 0;
    while (
      start < before.length &&
      start < after.length &&
      before[start] === after[start]
    )
      start++;
    let end = 0;
    while (
      end < before.length - start &&
      end < after.length - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]
    )
      end++;
    removed += before.length - start - end;
    added += after.length - start - end;
  }
  return { added, removed };
}

/** Normalise edit input the same way Pi's edit tool accepts it. */
export function editList(input = {}) {
  if (Array.isArray(input.edits)) return input.edits;
  if (typeof input.oldText === "string" || typeof input.newText === "string")
    return [{ oldText: input.oldText ?? "", newText: input.newText ?? "" }];
  return [];
}

/** Plain-text approval details for dialogs that cannot render custom components. */
export function approvalText(name, input = {}) {
  if (name === "powershell" || name === "bash")
    return (
      "Runs with your account permissions, without an OS sandbox.\n\n" +
      String(input.command ?? "")
    );
  if (name === "write") {
    const content = String(input.content ?? "");
    const count = content.replace(/\r?\n$/, "").split("\n").length;
    return `${input.path}\n${count} line${count === 1 ? "" : "s"}\n\n${content}`;
  }
  const edits = editList(input);
  const { added, removed } = editStats(edits);
  return (
    `${input.path}  (+${added} −${removed})\n\n` +
    edits
      .map((edit, i) =>
        [
          edits.length > 1 ? `Edit ${i + 1} of ${edits.length}` : "",
          ...String(edit.oldText ?? "")
            .split("\n")
            .map((line) => "- " + line),
          ...String(edit.newText ?? "")
            .split("\n")
            .map((line) => "+ " + line),
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n")
  );
}
