// One workspace and one active job per process; no TCP listener or desktop server.
import { StringDecoder } from "node:string_decoder";
import { VERSION } from "./config.js";
import {
  INPUT_LIMIT,
  checkedPrompt,
  positiveInteger,
  runHeadless,
} from "./headless.js";

export async function serveHeadless(
  runtime,
  {
    input = process.stdin,
    out = process.stdout,
    signal,
    timeout = 0,
    denials = [],
    sanitize = (value) => value,
    permissions = {},
  } = {},
) {
  let active,
    closing = false,
    buffer = "",
    ended = false;
  const decoder = new StringDecoder("utf8");
  const send = (value) => out.write(JSON.stringify(sanitize(value)) + "\n");
  const state = () => ({
    session: runtime.session.sessionManager.getSessionId(),
    busy: !!active,
    cwd: runtime.session.sessionManager.getCwd(),
    permissions,
  });
  const response = (id, command, success, data) =>
    send({
      type: "response",
      ...(id !== undefined ? { id } : {}),
      command,
      success,
      ...(success ? { data } : { error: data }),
    });
  const jobs = new Set();
  let cleanup,
    inputError,
    invalidLine = false;
  const stop = () => {
    closing = true;
    active?.controller.abort(signal?.reason);
    input.pause();
    input.emit("hermesdesk_stop");
    // A paused Windows stdin pipe can still keep Node alive after shutdown.
    input.destroy?.();
  };
  const handle = (line) => {
    if (!line.trim() || closing) return;
    let command;
    try {
      command = JSON.parse(line);
      if (
        !command ||
        Array.isArray(command) ||
        typeof command !== "object" ||
        typeof command.type !== "string"
      )
        throw Error("Expected a JSON object with a type.");
      if (
        command.id !== undefined &&
        !(typeof command.id === "string" && command.id.length <= 128) &&
        !Number.isSafeInteger(command.id)
      )
        throw Error(
          "id must be a string of at most 128 characters or an integer.",
        );
      const { id, type } = command;
      if (type === "get_state") return response(id, type, true, state());
      if (type === "abort") {
        active?.controller.abort();
        return response(id, type, true, { cancelling: !!active });
      }
      if (type === "shutdown") {
        response(id, type, true, { closing: true });
        stop();
        return;
      }
      if (type !== "prompt")
        throw Error("Use prompt, abort, get_state or shutdown.");
      if (active)
        throw Error(
          "A job is already running. Wait for done, or abort it before sending another prompt.",
        );
      checkedPrompt(command.message);
      const limit =
        command.timeout === undefined
          ? timeout
          : positiveInteger(command.timeout, "timeout");
      const controller = new AbortController();
      const job = { controller };
      active = job;
      response(id, type, true, { accepted: true, session: state().session });
      const work = runHeadless(runtime, command.message, {
        denials,
        timeout: limit,
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
        sanitize,
        onRecord: (event) => {
          // A host may submit its next prompt as soon as it reads done.
          if (event.type === "done" && active === job) active = undefined;
          send({ ...event, ...(id !== undefined ? { id } : {}) });
        },
      })
        .catch((error) => {
          response(id, type, false, error.message);
        })
        .finally(() => {
          if (active === job) active = undefined;
          jobs.delete(work);
        });
      jobs.add(work);
    } catch (error) {
      response(command?.id, command?.type || "parse", false, error.message);
    }
  };
  const onData = (chunk) => {
    buffer += decoder.write(Buffer.from(chunk));
    // Limit every line separately, including the unfinished tail.
    let index;
    while (!closing && (index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") > INPUT_LIMIT) {
        response(
          undefined,
          "parse",
          false,
          "Protocol lines are limited to 1 MiB.",
        );
        invalidLine = true;
        stop();
        return;
      }
      handle(line);
    }
    if (Buffer.byteLength(buffer, "utf8") > INPUT_LIMIT) {
      response(
        undefined,
        "parse",
        false,
        "Protocol lines are limited to 1 MiB.",
      );
      invalidLine = true;
      stop();
    }
  };
  signal?.addEventListener("abort", stop, { once: true });
  send({
    type: "ready",
    version: VERSION,
    protocol: 1,
    commands: ["prompt", "abort", "get_state", "shutdown"],
    ...state(),
  });
  try {
    if (signal?.aborted) return;
    await new Promise((resolve, reject) => {
      const finish = () => {
        if (ended) return;
        ended = true;
        buffer += decoder.end();
        if (!closing && buffer.trim()) handle(buffer);
        resolve();
      };
      const error = (err) => {
        inputError = err;
        stop();
        reject(err);
      };
      input.on("data", onData);
      input.once("end", finish);
      input.once("error", error);
      input.once("hermesdesk_stop", finish);
      cleanup = () => {
        input.off("data", onData);
        input.off("end", finish);
        input.off("error", error);
        input.off("hermesdesk_stop", finish);
      };

      if (input.readableEnded) finish();
    });
    // EOF drains a job, which also supports piping a single JSON prompt into the process.
    await Promise.allSettled([...jobs]);
    if (inputError) throw inputError;
    return { exitCode: invalidLine ? 2 : 0 };
  } finally {
    cleanup?.();
    signal?.removeEventListener("abort", stop);
    if (!ended) active?.controller.abort();
  }
}
