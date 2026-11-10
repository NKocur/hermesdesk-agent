// HermesDesk's interactive presentation: theme, header, footer, progress and tool rows.
// Approval and path decisions stay in policy.js.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createActivity } from "./activity.js";
import { footerFactory, headerFactory } from "./chrome.js";
import {
  approvalMode,
  friendlyError,
  limitText,
  usageTotals,
} from "./format.js";
import { loadPi } from "./pi.js";
import { probeServer, statusText } from "./status.js";
import { toolRenderer } from "./tools.js";
import { runInterrupt } from "./interrupt.js";

export const THEME_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "themes",
);

/**
 * Pi theme setting for HERMESDESK_THEME:
 *   auto (default)  HermesDesk light or dark, following the terminal background
 *   light | dark    force one HermesDesk palette
 *   terminal        Pi's "system" theme, built from the terminal's own palette
 */
export function themeSetting(value = process.env.HERMESDESK_THEME) {
  switch (
    String(value ?? "auto")
      .trim()
      .toLowerCase()
  ) {
    case "light":
      return "hermesdesk-light";
    case "dark":
      return "hermesdesk-dark";
    case "terminal":
    case "system":
      return "system";
    default:
      return "hermesdesk-light/hermesdesk-dark";
  }
}

// A quiet four-step pulse; every frame is one terminal column wide.
const PULSE = ["·", "•", "●", "•"];

// With HERMESDESK_BELL=on, runs at least this long ring the terminal bell when they finish.
const BELL_AFTER_MS = 30000;

const STREAM_KINDS = {
  thinking_start: "thinking",
  thinking_delta: "thinking",
  text_start: "writing",
  text_delta: "writing",
  toolcall_start: "calling",
  toolcall_delta: "calling",
};

/** What to tell the user when a reply ends at the output limit. */
export function truncationNotice(message, config) {
  const limit = limitText(config.maxTokens);
  const answered = message.content?.some(
    (part) =>
      (part.type === "text" && part.text?.trim()) || part.type === "toolCall",
  );
  if (!answered && config.thinking)
    return `Thinking used the whole ${limit} output limit before an answer. Cap it with /thinking-budget 8192, lower it with /think low, or choose a larger /profile.`;
  return `The reply reached the ${limit} output limit. Ask the agent to continue, or change the limit with /tokens.`;
}

export function interfaceExtension({
  version,
  readOnly,
  approveWrites,
  permissionMode,
  read,
  discover,
  activity = createActivity(),
  bell = process.env.HERMESDESK_BELL?.trim().toLowerCase() === "on"
    ? () => process.stdout.write("\x07")
    : undefined,
}) {
  const mode = permissionMode || approvalMode({ readOnly, approveWrites });
  return (pi) => {
    let current, removeInterrupt, timer, shown;
    const tui = (ctx) => ctx?.hasUI && ctx.mode === "tui";
    // The working line changes on phase changes and once a second, not on every token.
    const refresh = (ctx) => {
      if (!tui(ctx)) return;
      const text = activity.label();
      if (text !== shown) ctx.ui.setWorkingMessage((shown = text));
    };
    const title = (ctx, working) => {
      if (tui(ctx))
        ctx.ui.setTitle(
          (working ? "● " : "") + path.basename(ctx.cwd) + " · HermesDesk",
        );
    };
    const stopTimer = () => {
      clearInterval(timer);
      timer = undefined;
    };

    pi.registerToolRenderer(toolRenderer);
    pi.registerCommand("status", {
      description: "Check the model server, context fill and generation speed",
      handler: async (_args, ctx) => {
        const config = read();
        const probe = await probeServer(discover, config.model);
        let context, tokens;
        try {
          context = ctx.getContextUsage?.();
          tokens = usageTotals(ctx.sessionManager.getEntries());
        } catch {}
        ctx.ui.notify(
          statusText({ config, mode, probe, context, tokens, activity }),
          probe.ok && probe.available ? "info" : "warning",
        );
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      removeInterrupt?.();
      removeInterrupt = undefined;
      stopTimer();
      current = ctx;
      if (!ctx.hasUI) return;
      if (ctx.mode !== "tui") {
        ctx.ui.setStatus(
          "hermesdesk",
          `HermesDesk | ${mode.long.toLowerCase()}`,
        );
        return;
      }
      removeInterrupt = ctx.ui.onTerminalInput(runInterrupt(ctx));
      const { keyText } = await loadPi();
      const theme = ctx.ui.theme;
      ctx.ui.setHeader(headerFactory({ version, mode, keyText, read }));
      ctx.ui.setFooter(
        footerFactory({ getContext: () => current, read, mode, activity }),
      );
      ctx.ui.setWorkingIndicator({
        frames: PULSE.map((frame, i) =>
          theme.fg(i === 2 ? "accent" : "muted", frame),
        ),
        intervalMs: 140,
      });
      const toggle = keyText?.("app.thinking.toggle");
      ctx.ui.setHiddenThinkingLabel(
        "Reasoning hidden" + (toggle ? ` · ${toggle} to show` : ""),
      );
    });
    pi.on("session_shutdown", stopTimer);

    pi.on("agent_start", (_event, ctx) => {
      activity.runStart();
      stopTimer();
      if (!tui(ctx)) return;
      title(ctx, true);
      timer = setInterval(() => refresh(ctx), 1000);
      timer.unref?.();
      refresh(ctx);
    });
    pi.on("before_provider_request", (_event, ctx) => {
      activity.requestStart();
      refresh(ctx);
    });
    pi.on("message_update", (event, ctx) => {
      const e = event.assistantMessageEvent;
      const kind = STREAM_KINDS[e?.type];
      if (!kind) return;
      const toolName =
        e.type === "toolcall_start"
          ? e.partial?.content?.[e.contentIndex]?.name
          : undefined;
      if (activity.delta(kind, e.delta, toolName)) refresh(ctx);
    });
    pi.on("message_end", (event, ctx) => {
      const message = event.message;
      if (message?.role !== "assistant") return;
      activity.requestEnd(message.usage);
      refresh(ctx);
      if (message.stopReason === "length" && tui(ctx))
        ctx.ui.notify(truncationNotice(message, read()), "warning");
      if (message.stopReason === "error" && message.errorMessage) {
        const errorMessage = friendlyError(message.errorMessage);
        if (errorMessage !== message.errorMessage)
          return { message: { ...message, errorMessage } };
      }
    });
    // Runs after policy.js has approved the call, so the timer excludes time spent on approval.
    pi.on("tool_call", (event, ctx) => {
      activity.toolStart(event.toolName);
      refresh(ctx);
    });
    pi.on("tool_execution_end", (_event, ctx) => {
      activity.toolEnd();
      refresh(ctx);
    });
    pi.on("agent_settled", (_event, ctx) => {
      const ms = activity.runEnd();
      stopTimer();
      if (!tui(ctx)) return;
      shown = undefined;
      ctx.ui.setWorkingMessage();
      title(ctx, false);
      if (ms >= BELL_AFTER_MS) bell?.();
    });
  };
}
