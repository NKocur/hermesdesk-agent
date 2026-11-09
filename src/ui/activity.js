// Live generation telemetry. Local models make the wait visible: prompt processing before the
// first token, then a steady token rate. This module only keeps state and describes it; the
// interface extension feeds it events and shows label() beside the working indicator.

// Streaming text is counted in characters; the finished reply uses the server's token count.
const CHARS_PER_TOKEN = 4;
const STALL_MS = 15000;

const TOOL_LABELS = {
  read: "Reading",
  ls: "Listing",
  search: "Searching",
  edit: "Editing",
  write: "Writing file",
  powershell: "Running command",
  bash: "Running command",
};
const PHASE_LABELS = { thinking: "Thinking", writing: "Writing" };

/** Whole seconds for a ticking display: "8s", "1m 05s". */
export function elapsedText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return total < 60
    ? `${total}s`
    : `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** A finished duration: one decimal under ten seconds, otherwise as elapsedText. */
export function durationText(ms) {
  return ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : elapsedText(ms);
}

export function rateText(rate) {
  return `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} tok/s`;
}

export function createActivity(now = Date.now) {
  let run, request, tool, last;
  const totals = { replies: 0, tokens: 0, ms: 0, estimated: false };
  return {
    runStart() {
      run = { startedAt: now() };
      request = tool = undefined;
    },
    /** Ends the run and returns how long it took. */
    runEnd() {
      const ms = run ? now() - run.startedAt : 0;
      run = request = tool = undefined;
      return ms;
    },
    requestStart() {
      request = { startedAt: now(), phase: "waiting", chars: 0 };
      tool = undefined;
    },
    /**
     * Record streamed output. kind: "thinking" | "writing" | "calling".
     * Returns true when the phase changed, so the caller can refresh immediately.
     */
    delta(kind, text = "", toolName) {
      if (!request) return false;
      const at = now();
      request.firstAt ??= at;
      request.lastAt = at;
      request.chars += text.length;
      if (toolName) request.toolName = toolName;
      if (request.phase === kind) return false;
      request.phase = kind;
      request.phaseAt = at;
      return true;
    },
    /** Finish a reply. usage is the server's report; without it the estimate is kept. */
    requestEnd(usage) {
      const r = request;
      request = undefined;
      if (r?.firstAt === undefined) return;
      const ms = now() - r.firstAt;
      const estimated = !usage?.output;
      const tokens = estimated
        ? Math.round(r.chars / CHARS_PER_TOKEN)
        : usage.output;
      last = {
        waitMs: r.firstAt - r.startedAt,
        ms,
        tokens,
        estimated,
        // Very short replies give meaningless rates.
        rate: ms >= 500 && tokens >= 8 ? tokens / (ms / 1000) : undefined,
      };
      if (last.rate) {
        totals.replies++;
        totals.tokens += tokens;
        totals.ms += ms;
        totals.estimated ||= estimated;
      }
    },
    toolStart(name) {
      tool = { name, startedAt: now() };
    },
    toolEnd() {
      tool = undefined;
    },
    /** Text for the working indicator, or undefined to use the default. */
    label() {
      const at = now();
      if (tool) {
        const ms = at - tool.startedAt;
        return (
          (TOOL_LABELS[tool.name] ?? `Running ${tool.name}`) +
          (ms >= 2000 ? ` · ${elapsedText(ms)}` : "")
        );
      }
      if (!request) return run ? "Working" : undefined;
      if (request.phase === "waiting") {
        const ms = at - request.startedAt;
        return (
          "Waiting for model" +
          (ms >= 2000 ? ` · ${elapsedText(ms)}` : "") +
          (ms >= 60000
            ? " · the model may still be loading"
            : ms >= 12000
              ? " · processing the prompt"
              : "")
        );
      }
      const name =
        PHASE_LABELS[request.phase] ??
        `Preparing ${request.toolName ?? "tool call"}`;
      const parts = [name];
      if (at - request.phaseAt >= 2000)
        parts.push(elapsedText(at - request.phaseAt));
      const quiet = at - request.lastAt;
      const ms = at - request.firstAt;
      const tokens = request.chars / CHARS_PER_TOKEN;
      if (quiet >= STALL_MS) parts.push(`no output for ${elapsedText(quiet)}`);
      else if (ms >= 1500 && tokens >= 8)
        parts.push("~" + rateText(tokens / (ms / 1000)));
      return parts.join(" · ");
    },
    get last() {
      return last;
    },
    /** Session average over replies long enough to measure. */
    get average() {
      return totals.ms
        ? {
            replies: totals.replies,
            rate: totals.tokens / (totals.ms / 1000),
            estimated: totals.estimated,
          }
        : undefined;
    },
  };
}
