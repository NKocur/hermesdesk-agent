// Startup header and persistent footer for interactive chat.
import {
  BRAND,
  countText,
  displayPath,
  limitText,
  thinkingText,
} from "./format.js";
import {
  fitSegments,
  spread,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "./layout.js";

/** Brand line, one orientation line, and the commands people need first. */
export function headerFactory({ version, mode, keyText }) {
  const key = (id, fallback) => {
    try {
      return keyText?.(id) || fallback;
    } catch {
      return fallback;
    }
  };
  return (_tui, theme) => ({
    render(width) {
      const sep = theme.fg("dim", " · ");
      const brand =
        theme.fg("accent", "◆ ") +
        theme.bold(BRAND) +
        " " +
        theme.fg("dim", version);
      const about =
        mode.short === "read-only"
          ? "Read-only: the agent can read and search this workspace, but cannot change it."
          : "File tools stay inside this workspace. " +
            (mode.short === "asks first"
              ? "Edits and commands ask first."
              : "Edits apply without asking; commands ask first.");
      const hints = [
        theme.fg("accent", "/limits") + theme.fg("dim", " settings"),
        theme.fg("accent", "/profile"),
        theme.fg("accent", "/think"),
        theme.fg("dim", key("app.interrupt", "esc") + " stop"),
        theme.fg("dim", key("app.tools.expand", "ctrl+o") + " tool output"),
      ];
      const room = Math.max(1, width - 3);
      return [
        " " + truncateToWidth(brand, width - 1, "…"),
        ...wrapTextWithAnsi(theme.fg("muted", about), room).map(
          (line) => "   " + line,
        ),
        "   " + fitSegments(hints, room, sep),
        "",
      ].map((line) => truncateToWidth(line, width, ""));
    },
    invalidate() {},
  });
}

/**
 * Two-line footer:
 *   workspace · branch                       model · think xhigh · 64K out
 *   ● approval mode   other statuses                  ↑in ↓out · ctx 3% of 256K
 */
export function footerFactory({ getContext, read, mode }) {
  return (tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
    let cacheKey, cached;
    const usage = (ctx) => {
      const sm = ctx.sessionManager;
      const entries = sm.getEntries();
      const keyNow = `${sm.getSessionId?.()}:${sm.getLeafId?.()}:${entries.length}`;
      if (keyNow === cacheKey) return cached;
      let input = 0,
        output = 0;
      for (const entry of entries) {
        const u =
          entry.type === "message" && entry.message?.role === "assistant"
            ? entry.message.usage
            : entry.type === "usage"
              ? entry.usage
              : undefined;
        if (!u) continue;
        input += (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        output += u.output || 0;
      }
      cacheKey = keyNow;
      cached = { input, output };
      return cached;
    };
    return {
      dispose: unsubscribe,
      invalidate() {
        cacheKey = undefined;
      },
      render(width) {
        const ctx = getContext();
        const config = read();
        const dot = theme.fg("dim", " · ");
        let cwd = process.cwd(),
          tokens = { input: 0, output: 0 },
          context;
        try {
          cwd = ctx?.sessionManager.getCwd() ?? cwd;
          tokens = ctx ? usage(ctx) : tokens;
          context = ctx?.getContextUsage();
        } catch {}
        const branch = footerData.getGitBranch?.();
        const model = ctx?.model?.id ?? config.model ?? "no model";

        // Line 1: where and with what.
        const settings = [
          theme.fg("muted", model),
          theme.fg(
            config.thinking ? "accent" : "dim",
            "think " + thinkingText(config),
          ),
          theme.fg("muted", limitText(config.maxTokens) + " out"),
        ];
        const right1 = fitSegments(
          settings,
          Math.max(12, Math.floor(width * 0.55)),
          dot,
        );
        const pathRoom = Math.max(
          8,
          width - visibleWidth(right1) - 4 - (branch ? branch.length + 3 : 0),
        );
        const where =
          " " +
          theme.fg("text", displayPath(cwd, pathRoom)) +
          (branch ? dot + theme.fg("dim", branch) : "");

        // Line 2: safety mode, extension statuses, usage.
        const statuses = [];
        for (const [, text] of footerData.getExtensionStatuses?.() ?? [])
          if (text)
            statuses.push(theme.fg("dim", String(text).replace(/\s+/g, " ")));
        const left2 =
          " " +
          theme.fg(mode.tone, "●") +
          " " +
          theme.fg(mode.tone === "warning" ? "warning" : "muted", mode.short) +
          (statuses.length ? "  " + statuses.join(dot) : "");
        const windowSize = context?.contextWindow ?? config.context;
        const percent = context?.percent;
        const pct =
          percent === null || percent === undefined
            ? "?"
            : percent < 10
              ? percent.toFixed(1)
              : Math.round(percent).toString();
        const tone = percent > 90 ? "error" : percent > 70 ? "warning" : "dim";
        // Context fill matters most, so it is kept when the line is too narrow for token totals.
        const fill = theme.fg(tone, `ctx ${pct}% of ${limitText(windowSize)}`);
        const totals =
          tokens.input || tokens.output
            ? theme.fg(
                "dim",
                `↑${countText(tokens.input)} ↓${countText(tokens.output)}`,
              ) + dot
            : "";
        const room = width - visibleWidth(left2) - 3;
        const right2 =
          visibleWidth(totals + fill) <= room ? totals + fill : fill;
        return [
          spread(where, right1 + " ", width),
          spread(left2, right2 + " ", width),
        ];
      },
    };
  };
}
