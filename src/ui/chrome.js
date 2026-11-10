// Startup header and persistent footer for interactive chat.
import { rateText } from "./activity.js";
import {
  BRAND,
  countText,
  displayPath,
  limitText,
  percentText,
  thinkingText,
  usageTotals,
} from "./format.js";
import {
  fitSegments,
  meter,
  spread,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "./layout.js";

/** The server's host name, so it is clear which machine is doing the work. */
export function serverHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/** Brand and connected model, one orientation line, and the commands people need first. */
export function headerFactory({ version, mode, keyText, read }) {
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
        " " +
        theme.fg("accent", "◆ ") +
        theme.bold(BRAND) +
        " " +
        theme.fg("dim", version);
      const config = read?.() ?? {};
      const host = serverHost(config.baseUrl);
      const server = config.model
        ? theme.fg("muted", config.model) +
          (host ? theme.fg("dim", " on " + host) : "") +
          " "
        : "";
      const about =
        mode.short === "read-only"
          ? "Read-only: the agent can read and search this workspace, but cannot change it."
          : "File tools stay inside this workspace. " +
            (mode.short === "asks first"
              ? "Edits and commands ask first."
              : mode.short === "Fuck it Mode"
                ? "Edits and shell commands run without asking."
                : "Edits apply without asking; commands ask first.");
      const hints = [
        theme.fg("accent", "/limits") + theme.fg("dim", " settings"),
        theme.fg("accent", "/permissions"),
        theme.fg("dim", "ctrl+c stop"),
        theme.fg("accent", "/status") + theme.fg("dim", " server"),
        theme.fg("accent", "/profile"),
        theme.fg("accent", "/think"),
        theme.fg("dim", key("app.tools.expand", "ctrl+o") + " tool output"),
      ];
      const room = Math.max(1, width - 3);
      return [
        spread(brand, server, width),
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
 *   workspace · branch                          model · think xhigh · 64K out
 *   ● approval mode   statuses      ↑in ↓out · 38 tok/s · ━━━━━━━━ ctx 3% of 256K
 */
export function footerFactory({ getContext, read, mode, activity }) {
  return (tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
    let cacheKey, cached;
    const usage = (ctx) => {
      const sm = ctx.sessionManager;
      const entries = sm.getEntries();
      const keyNow = `${sm.getSessionId?.()}:${sm.getLeafId?.()}:${entries.length}`;
      if (keyNow !== cacheKey) {
        cacheKey = keyNow;
        cached = usageTotals(entries);
      }
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
        const tone = percent > 90 ? "error" : percent > 70 ? "warning" : "dim";
        const fill = theme.fg(
          tone,
          `ctx ${percentText(percent)}% of ${limitText(windowSize)}`,
        );
        const bar =
          meter(theme, percent, 8, tone === "dim" ? "accent" : tone) + " ";
        const totals =
          tokens.input || tokens.output
            ? theme.fg(
                "dim",
                `↑${countText(tokens.input)} ↓${countText(tokens.output)}`,
              ) + dot
            : "";
        const rate = activity?.last?.rate;
        const speed = rate
          ? theme.fg(
              "muted",
              (activity.last.estimated ? "~" : "") + rateText(rate),
            ) + dot
          : "";
        // Context fill matters most, so it is the last thing dropped on narrow terminals.
        const room = width - visibleWidth(left2) - 3;
        const right2 =
          [totals + speed + bar + fill, speed + bar + fill, bar + fill].find(
            (text) => visibleWidth(text) <= room,
          ) ?? fill;
        return [
          spread(where, right1 + " ", width),
          spread(left2, right2 + " ", width),
        ];
      },
    };
  };
}
