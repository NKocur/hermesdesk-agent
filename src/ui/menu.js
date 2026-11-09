// Settings menus. Interactive chat gets a titled list with descriptions;
// other UI hosts receive the same values through Pi's plain selector.
import { SelectList } from "@earendil-works/pi-tui";
import { rule, truncateToWidth } from "./layout.js";

/**
 * items: [{ value, label, description?, current? }]. Resolves to the chosen value or undefined.
 * `value` is what non-interactive hosts and tests see, so it stays stable and descriptive.
 */
export async function chooseItem(ctx, { title, subtitle, items }) {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function")
    return ctx.ui.select(
      title,
      items.map((item) => item.value),
    );
  return ctx.ui.custom((tui, theme, _keybindings, done) => {
    const list = new SelectList(
      items.map((item) => ({
        value: item.value,
        label: (item.current ? "● " : "  ") + item.label,
        description: item.description,
      })),
      Math.min(items.length, 10),
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", theme.bold(text)),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("dim", text),
      },
      { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 26 },
    );
    const current = items.findIndex((item) => item.current);
    if (current > 0) list.setSelectedIndex(current);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    return {
      render(width) {
        const lines = [
          rule(theme, width, theme.fg("accent", theme.bold(title))),
        ];
        if (subtitle) lines.push(" " + theme.fg("muted", subtitle));
        lines.push(...list.render(width));
        lines.push(" " + theme.fg("dim", "↑↓ move · enter choose · esc close"));
        return lines.map((line) => truncateToWidth(line, width, "…"));
      },
      handleInput(data) {
        list.handleInput(data);
        tui.requestRender();
      },
      invalidate() {
        list.invalidate();
      },
    };
  });
}
