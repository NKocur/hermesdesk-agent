// Non-interactive jobs share the normal Pi runtime and workspace policy.
import fs from "node:fs/promises";
import path from "node:path";
import { VERSION } from "./config.js";
import { friendlyError } from "./ui/format.js";

export const INPUT_LIMIT = 1024 * 1024;
export const EXIT = {
  completed: 0,
  failed: 1,
  invalid: 2,
  blocked: 3,
  truncated: 4,
  timeout: 124,
  cancelled: 130,
  terminated: 143,
};
export function invalid(message) {
  return Object.assign(new Error(message), { exitCode: EXIT.invalid });
}
export function positiveInteger(value, name, max = 86400) {
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > max
  )
    throw invalid(`${name} must be an integer from 1 to ${max}.`);
  return Number(value);
}
export function outputFormat(value, json) {
  if (value !== undefined && !["text", "json", "jsonl"].includes(value))
    throw invalid("Use --output-format text, json or jsonl.");
  if (json && value && value !== "jsonl")
    throw invalid(
      "--json is an alias for --output-format jsonl; choose one format.",
    );
  return value || (json ? "jsonl" : "text");
}
export function checkedPrompt(text) {
  if (typeof text !== "string" || !text.trim())
    throw invalid("Provide a non-empty request.");
  if (Buffer.byteLength(text, "utf8") > INPUT_LIMIT)
    throw invalid("Requests are limited to 1 MiB of UTF-8 text.");
  if (text.trimStart().startsWith("!"))
    throw invalid(
      "Headless prompts cannot use bang commands. Ask the agent to run a command instead.",
    );
  return text.replace(/^\uFEFF/, "");
}
export async function readPrompt({
  args = [],
  promptFile,
  stdin = false,
  input = process.stdin,
}) {
  const piped = stdin || (args.length === 1 && args[0] === "-");
  if (
    Number(!!promptFile) +
      Number(piped) +
      Number(args.length > 0 && !(args.length === 1 && args[0] === "-")) !==
    1
  )
    throw invalid(
      "Choose one request source: arguments, --prompt-file PATH, or --stdin (run -).",
    );
  if (promptFile) {
    const file = await fs.open(path.resolve(promptFile), "r");
    try {
      const data = Buffer.alloc(INPUT_LIMIT + 1);
      let size = 0;
      while (size < data.length) {
        const part = await file.read(data, size, data.length - size, null);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size > INPUT_LIMIT)
        throw invalid("Requests are limited to 1 MiB of UTF-8 text.");
      return checkedPrompt(data.subarray(0, size).toString("utf8"));
    } finally {
      await file.close();
    }
  }
  if (!piped) return checkedPrompt(args.join(" "));
  if (input.isTTY) throw invalid("--stdin requires piped input.");
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > INPUT_LIMIT)
      throw invalid("Requests are limited to 1 MiB of UTF-8 text.");
    chunks.push(b);
  }
  return checkedPrompt(Buffer.concat(chunks).toString("utf8"));
}

export async function runHeadless(
  runtime,
  prompt,
  {
    format = "text",
    out = process.stdout,
    err = process.stderr,
    signal,
    timeout = 0,
    denials = [],
    onRecord,
    sanitize = (value) => value,
  } = {},
) {
  checkedPrompt(prompt);
  denials.length = 0;
  const start = Date.now(),
    usage = { input: 0, output: 0 };
  let text = "",
    lastText = "",
    failure,
    stopReason,
    cancelled,
    timer;
  const send = (record) => {
    if (onRecord) onRecord(sanitize(record));
    else if (format === "jsonl")
      out.write(JSON.stringify(sanitize(record)) + "\n");
  };
  const stop = (status) => {
    cancelled ||= status;
    void runtime.session.abort().catch(() => {});
  };
  const onAbort = () =>
    stop(signal?.reason?.status === "terminated" ? "terminated" : "cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (timeout) timer = setTimeout(() => stop("timeout"), timeout * 1000);
  const off = runtime.session.subscribe((event) => {
    if (event.type === "agent_start" && cancelled) stop(cancelled);
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      const delta = event.assistantMessageEvent.delta;
      text += delta;
      if (format === "text" && !onRecord) out.write(sanitize(delta));
      send({ type: "text", text: delta });
    }
    if (event.type === "tool_execution_start") {
      send({
        type: "tool",
        name: event.toolName,
        toolCallId: event.toolCallId,
        input: event.args,
      });
      if (format === "text" && !onRecord) err.write(`\n[${event.toolName}]\n`);
    }
    if (event.type === "tool_execution_end")
      send({
        type: "tool_result",
        name: event.toolName,
        toolCallId: event.toolCallId,
        isError: !!event.isError,
        result: event.result,
      });
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const m = event.message;
      lastText = (m.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      usage.input +=
        (m.usage?.input || 0) +
        (m.usage?.cacheRead || 0) +
        (m.usage?.cacheWrite || 0);
      usage.output += m.usage?.output || 0;
      stopReason = m.stopReason;
      if (["error", "aborted"].includes(stopReason))
        failure = friendlyError(m.errorMessage || stopReason);
    }
  });
  const session = runtime.session.sessionManager.getSessionId();
  send({ type: "start", version: VERSION, session });
  try {
    if (signal?.aborted) onAbort();
    await runtime.session.bindExtensions({});
    if (!cancelled)
      await runtime.session.prompt(prompt, {
        expandPromptTemplates: false,
        source: "rpc",
      });
  } catch (error) {
    failure = friendlyError(error.message);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    off();
  }
  const status =
    cancelled ||
    (failure
      ? stopReason === "aborted"
        ? "cancelled"
        : "failed"
      : stopReason === "length"
        ? "truncated"
        : denials.length
          ? "blocked"
          : "completed");
  const result = {
    type: "done",
    version: VERSION,
    ok: status === "completed",
    status,
    exitCode: EXIT[status],
    session,
    text: lastText || text,
    stopReason: stopReason || null,
    usage,
    durationMs: Date.now() - start,
    ...(denials.length ? { blocked: [...denials] } : {}),
    ...(failure || cancelled
      ? { error: cancelled ? `Run ${cancelled}.` : failure }
      : {}),
  };
  if (result.error) send({ type: "error", status, message: result.error });
  send(result);
  if (!onRecord) {
    if (format === "json") out.write(JSON.stringify(sanitize(result)) + "\n");
    if (format === "text") {
      out.write("\n");
      if (result.error) err.write(sanitize(result.error) + "\n");
    }
  }
  return sanitize(result);
}
