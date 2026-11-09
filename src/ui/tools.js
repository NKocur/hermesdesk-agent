// Compact tool rows: a status glyph on the call line and a quiet gutter beside output.
// Pi's own renderers still draw the content (diffs, highlighting, truncation and expansion);
// this layer only replaces the boxed shell so rows take less vertical space.
import {
  Text,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Prefixed } from "./layout.js";

const SHELLS = new Set(["powershell", "bash"]);
const TOOLS = new Set(["read", "ls", "search", "edit", "write", ...SHELLS]);

function state(context) {
  if (!context.executionStarted) return "pending";
  if (context.isPartial) return "running";
  return context.isError ? "error" : "done";
}

const GLYPH = {
  pending: ["dim", "○"],
  running: ["accent", "●"],
  done: ["success", "✓"],
  error: ["error", "✗"],
};

/** Hand Pi's renderer its own previous component, not our wrapper. */
function innerContext(context) {
  let component = context.lastComponent;
  while (component instanceof Prefixed || component instanceof Compact)
    component = component.inner;
  return Object.create(context, { lastComponent: { value: component } });
}

function seconds(ms) {
  return ms >= 1000 ? ` ${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : "";
}

function searchCall(args, theme) {
  return new Text(
    theme.fg("toolTitle", theme.bold("search ")) +
      theme.fg("accent", JSON.stringify(String(args?.query ?? ""))) +
      (args?.path ? theme.fg("dim", " in " + args.path) : ""),
    0,
    0,
  );
}

function searchResult(result, { expanded }, theme, context) {
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (context.isError)
    return new Text(theme.fg("error", text || "Search failed."), 0, 0);
  const lines = text.split("\n").filter(Boolean);
  const matches = lines.filter((l) => /^[^:]+:\d+: /.test(l));
  const files = new Set(matches.map((l) => l.split(":")[0])).size;
  let out = matches.length
    ? theme.fg(
        "muted",
        `${matches.length} match${matches.length === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}`,
      )
    : theme.fg("muted", "No matches");
  if (result.details?.truncated) out += theme.fg("warning", " · limit reached");
  const shown = expanded ? matches : matches.slice(0, 6);
  for (const line of shown) {
    const [file, number, ...rest] = line.split(":");
    out +=
      "\n" +
      theme.fg("accent", file) +
      theme.fg("dim", `:${number}:`) +
      theme.fg("toolOutput", rest.join(":"));
  }
  if (shown.length < matches.length)
    out +=
      "\n" +
      theme.fg("dim", `… ${matches.length - shown.length} more `) +
      context.keyHint("app.tools.expand", "to expand");
  return new Text(out, 0, 0);
}

const blank = (line) => !stripTerminalSequences(line).trim();

/**
 * Renders a Pi tool component without its own panel: no background, no blank padding rows,
 * optionally only the first line (used while an approval dialog shows the full preview).
 */
class Compact {
  constructor(inner, { firstLineOnly = false, suffix = "" } = {}) {
    this.inner = inner;
    this.firstLineOnly = firstLineOnly;
    this.suffix = suffix;
    // Pi's edit renderer draws a tinted Box; the gutter replaces that panel.
    inner?.setBgFn?.((text) => text);
    inner?.setPaddingX?.(0);
  }
  render(width) {
    let lines = this.inner?.render(width) ?? [];
    let start = 0,
      end = lines.length;
    while (start < end && blank(lines[start])) start++;
    while (end > start && blank(lines[end - 1])) end--;
    lines = lines.slice(start, end);
    // Remove shared indentation left by the panel's horizontal padding.
    const indent = Math.min(
      ...lines
        .filter((line) => !blank(line))
        .map((line) => stripTerminalSequences(line).match(/^ */)[0].length),
    );
    if (indent > 0 && Number.isFinite(indent))
      lines = lines.map((line) => sliceByColumn(line, indent, width));
    if (this.firstLineOnly) lines = lines.slice(0, 1);
    if (this.suffix && lines.length)
      lines[0] = truncateToWidth(lines[0] + this.suffix, width, "");
    return lines;
  }
  invalidate() {
    this.inner?.invalidate?.();
  }
}

export function toolRenderer(toolName, next) {
  const base = next();
  if (!TOOLS.has(toolName)) return base;
  const call =
    base?.renderCall ?? (toolName === "search" ? searchCall : undefined);
  const result =
    base?.renderResult ?? (toolName === "search" ? searchResult : undefined);
  const previews = toolName === "edit" || toolName === "write";
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const s = state(context);
      const [color, glyph] = GLYPH[s];
      const settled = s === "done" || s === "error";
      const inner = call
        ? call(args, theme, innerContext(context))
        : new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
      // Edit and write previews are shown by the approval dialog while pending, and are
      // pointless after a refusal; the full preview stays in the transcript once applied.
      const row = new Compact(inner, {
        firstLineOnly: previews && s !== "done",
        // Shell results already end with Pi's "Took …" line.
        suffix:
          settled && !SHELLS.has(toolName)
            ? theme.fg("dim", seconds(context.durationMs ?? 0))
            : "",
      });
      return new Prefixed(row, (i) =>
        i ? theme.fg("borderMuted", " │ ") : " " + theme.fg(color, glyph) + " ",
      );
    },
    renderResult(value, options, theme, context) {
      if (!result) return new Text("", 0, 0);
      const inner = result(value, options, theme, innerContext(context));
      const gutter = context.isError ? "error" : "borderMuted";
      return new Prefixed(new Compact(inner), () => theme.fg(gutter, " │ "));
    },
  };
}
