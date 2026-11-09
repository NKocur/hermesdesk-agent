// Pi is imported lazily so callers can set PI_CODING_AGENT_DIR first (see createRuntime).
let loaded;
export async function loadPi() {
  return (loaded ??= await import("@earendil-works/pi-coding-agent"));
}
