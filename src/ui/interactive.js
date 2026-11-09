// Starts Pi's interactive mode for a HermesDesk runtime. The terminal option exists for tests and captures.
import { loadPi } from "./pi.js";

export async function createInteractiveMode(
  runtime,
  { initialMessage, terminal } = {},
) {
  const { InteractiveMode } = await loadPi();
  return new InteractiveMode(runtime, {
    verbose: false,
    initialMessage,
    ...(terminal ? { terminal } : {}),
  });
}
