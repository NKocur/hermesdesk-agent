// HermesDesk's interactive presentation: theme, header, footer, progress and tool rows.
// Display only: approval and path decisions stay in policy.js.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { footerFactory, headerFactory } from "./chrome.js";
import { approvalMode } from "./format.js";
import { loadPi } from "./pi.js";
import { toolRenderer } from "./tools.js";

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

export function interfaceExtension({ version, readOnly, approveWrites, read }) {
  const mode = approvalMode({ readOnly, approveWrites });
  return (pi) => {
    let current;
    pi.registerToolRenderer(toolRenderer);
    pi.on("session_start", async (_event, ctx) => {
      current = ctx;
      if (!ctx.hasUI) return;
      if (ctx.mode !== "tui") {
        ctx.ui.setStatus(
          "hermesdesk",
          `HermesDesk | ${mode.long.toLowerCase()}`,
        );
        return;
      }
      const { keyText } = await loadPi();
      const theme = ctx.ui.theme;
      ctx.ui.setHeader(headerFactory({ version, mode, keyText }));
      ctx.ui.setFooter(
        footerFactory({ getContext: () => current, read, mode }),
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
  };
}
