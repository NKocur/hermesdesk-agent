// Starts Pi's interactive mode for a HermesDesk runtime. The terminal option exists for tests and captures.
import { loadPi } from "./pi.js";

export async function createInteractiveMode(
  runtime,
  { initialMessage, terminal } = {},
) {
  // Pi is a pinned SDK dependency. Its standalone update command cannot update
  // HermesDesk, so suppress the SDK's automatic release banner and changelog link.
  process.env.PI_SKIP_VERSION_CHECK = "1";
  const { InteractiveMode } = await loadPi();
  return new InteractiveMode(runtime, {
    verbose: false,
    initialMessage,
    ...(terminal ? { terminal } : {}),
  });
}
