// Ctrl+C interrupts work through Pi's public cancellation API. Idle Ctrl+C
// keeps Pi's clear-input / double-press-to-exit behavior.
import { matchesKey } from "@earendil-works/pi-tui";

export function runInterrupt(ctx) {
  return (data) => {
    if (!matchesKey(data, "ctrl+c") || ctx.isIdle()) return;
    ctx.abort();
    // Consume it so Pi's clear/exit shortcut cannot also run.
    return { consume: true };
  };
}
