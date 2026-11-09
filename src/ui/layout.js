// Width-safe layout primitives. Every function returns lines that fit the given width.
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export { truncateToWidth, visibleWidth, wrapTextWithAnsi };

/** Join styled segments with a separator, dropping trailing segments that do not fit. */
export function fitSegments(segments, width, separator) {
  const parts = segments.filter(Boolean);
  let out = "";
  for (const part of parts) {
    const next = out ? out + separator + part : part;
    if (visibleWidth(next) > width) break;
    out = next;
  }
  return out || truncateToWidth(parts[0] ?? "", width, "…");
}

/** Left and right content on one line. The right side shrinks first; the left side truncates last. */
export function spread(left, right, width, minGap = 2) {
  const rightWidth = visibleWidth(right);
  const leftWidth = visibleWidth(left);
  if (!right || leftWidth + minGap + rightWidth > width)
    return truncateToWidth(left, width, "…");
  return left + " ".repeat(width - leftWidth - rightWidth) + right;
}

/** A horizontal rule with an optional inline title: "── Title ─────". */
export function rule(theme, width, title = "", color = "borderMuted") {
  if (width <= 0) return "";
  if (!title) return theme.fg(color, "─".repeat(width));
  const head = theme.fg(color, "── ");
  const label = truncateToWidth(title, Math.max(1, width - 6), "…");
  const used = visibleWidth(head) + visibleWidth(label) + 1;
  return (
    head + label + " " + theme.fg(color, "─".repeat(Math.max(0, width - used)))
  );
}

/** A fixed-width fill bar. Any non-zero value shows at least one cell. */
export function meter(theme, percent, cells = 8, color = "accent") {
  const share = Math.max(0, Math.min(100, percent || 0)) / 100;
  const filled = share ? Math.max(1, Math.round(share * cells)) : 0;
  return (
    theme.fg(color, "━".repeat(filled)) +
    theme.fg("borderMuted", "━".repeat(cells - filled))
  );
}

/** Wraps another component and prefixes each rendered line, e.g. a status glyph or gutter. */
export class Prefixed {
  constructor(inner, prefix) {
    this.inner = inner;
    this.prefix = prefix; // (index) => styled string of constant visible width
  }
  render(width) {
    const first = this.prefix(0);
    const room = Math.max(1, width - visibleWidth(first));
    const lines = this.inner?.render(room) ?? [];
    return lines.map((line, i) =>
      truncateToWidth((i ? this.prefix(i) : first) + line, width, ""),
    );
  }
  invalidate() {
    this.inner?.invalidate?.();
  }
  handleMouse(event) {
    return this.inner?.handleMouse?.(event);
  }
}
