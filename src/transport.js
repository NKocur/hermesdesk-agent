import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import path from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
// Use Node's native HTTP transport. The public gateway challenged undici/fetch during testing.
export async function nativeFetch(input, init) {
  const r = new Request(input, init),
    u = new URL(r.url);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("Unsupported transport protocol.");
  r.signal.throwIfAborted();
  const body = r.body ? Buffer.from(await r.arrayBuffer()) : null;
  if (body?.length > 2 * 1024 * 1024)
    throw Error("The model request exceeds 2 MB; compact the conversation.");
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(r.headers);
    headers["accept-encoding"] = "identity";
    if (body) headers["content-length"] = String(body.length);
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      { method: r.method, headers, signal: r.signal },
      (res) => {
        const outHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined)
            outHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
        let stream = res;
        const encoding = res.headers["content-encoding"];
        if (["gzip", "deflate", "br"].includes(encoding)) {
          const decoder =
            encoding === "gzip"
              ? zlib.createGunzip()
              : encoding === "br"
                ? zlib.createBrotliDecompress()
                : zlib.createInflate();
          res.on("error", (e) => decoder.destroy(e));
          stream = res.pipe(decoder);
          outHeaders.delete("content-encoding");
          outHeaders.delete("content-length");
        }
        const response = new Response(
          [204, 205, 304].includes(res.statusCode)
            ? null
            : Readable.toWeb(stream),
          {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: outHeaders,
          },
        );
        Object.defineProperty(response, "url", { value: u.href });
        resolve(response);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
export function modelFetch(baseUrl) {
  const allowed = new URL(baseUrl);
  return (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (
      u.origin !== allowed.origin ||
      !["/v1/models", "/v1/chat/completions"].includes(u.pathname) ||
      u.search ||
      u.hash
    )
      throw Error("Unexpected model endpoint.");
    return (process.platform === "win32" ? curlFetch : nativeFetch)(
      input,
      init,
    );
  };
}
export async function discover(config, token) {
  const r = await modelFetch(config.baseUrl)(config.baseUrl + "/models", {
    headers: {
      Authorization: "Bearer " + token,
      "User-Agent": "HermesDesk-CLI/1.0",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw Error(
      r.status === 401
        ? "API key is invalid, revoked or expired."
        : r.status === 403
          ? "Cloudflare rejected this client connection."
          : "Model discovery failed (HTTP " + r.status + ").",
    );
  }
  const data = await r.json();
  if (!Array.isArray(data.data))
    throw Error("The endpoint did not return a model catalog.");
  return data.data.map((m) => m.id).filter((x) => typeof x === "string");
}

function curlQuote(value) {
  return (
    '"' +
    String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t") +
    '"'
  );
}
export async function curlFetch(input, init) {
  const r = new Request(input, init);
  r.signal.throwIfAborted();
  const data = r.body ? Buffer.from(await r.arrayBuffer()) : null;
  if (data?.length > 2 * 1024 * 1024)
    throw Error("The model request exceeds 2 MB; compact the conversation.");
  const lines = [
    "url = " + curlQuote(r.url),
    "request = " + curlQuote(r.method),
    'user-agent = "HermesDesk-CLI/1.0"',
    'header = "Expect:"',
  ];
  for (const [key, value] of r.headers)
    if (["authorization", "content-type", "accept"].includes(key))
      lines.push("header = " + curlQuote(key + ": " + value));
  if (data) lines.push("data-binary = " + curlQuote(data.toString("utf8")));
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(process.env.SystemRoot || "C:/Windows", "System32/curl.exe"),
      [
        "--silent",
        "--show-error",
        "--http1.1",
        "--include",
        "--compressed",
        "--max-time",
        "1800",
        "--config",
        "-",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stream = new PassThrough();
    let buffer = Buffer.alloc(0),
      headersDone = false,
      stderr = "",
      settled = false;
    const abort = () => {
      child.kill();
      stream.destroy(new DOMException("Request cancelled", "AbortError"));
      if (!settled) {
        settled = true;
        reject(new DOMException("Request cancelled", "AbortError"));
      }
    };
    stream.on("error", () => {});
    r.signal.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (b) => {
      if (stderr.length < 4096) stderr += b.toString();
    });
    const fail = () => {
      const error = new Error(
        "Windows HTTP transport failed" +
          (child.exitCode ? " (curl " + child.exitCode + ")" : "") +
          ". Check the server address and connection.",
      );
      if (!settled) {
        settled = true;
        reject(error);
      } else stream.destroy(error);
    };
    child.on("error", fail);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      if (headersDone) {
        if (!stream.write(chunk)) child.stdout.pause();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      let end;
      while ((end = buffer.indexOf("\r\n\r\n")) >= 0) {
        const raw = buffer.subarray(0, end).toString("latin1"),
          rows = raw.split("\r\n"),
          match = /^HTTP\/\S+ (\d{3})/.exec(rows.shift());
        buffer = buffer.subarray(end + 4);
        if (!match) {
          child.kill();
          fail();
          return;
        }
        const status = Number(match[1]);
        if (status < 200) continue;
        const headers = new Headers();
        for (const line of rows) {
          const at = line.indexOf(":");
          if (at > 0)
            headers.append(line.slice(0, at), line.slice(at + 1).trim());
        }
        headers.delete("content-encoding");
        headers.delete("content-length");
        headers.delete("transfer-encoding");
        headersDone = true;
        const response = new Response(
          [204, 205, 304].includes(status) ? null : Readable.toWeb(stream),
          { status, headers },
        );
        Object.defineProperty(response, "url", { value: r.url });
        settled = true;
        resolve(response);
        if (buffer.length && !stream.write(buffer)) child.stdout.pause();
        buffer = Buffer.alloc(0);
        break;
      }
      if (!headersDone && buffer.length > 65536) {
        child.kill();
        fail();
      }
    });
    stream.on("drain", () => child.stdout.resume());
    stream.on("close", () => {
      if (!child.stdout.readableEnded) child.kill();
    });
    child.on("close", (code) => {
      r.signal.removeEventListener("abort", abort);
      if (code === 0 && headersDone) stream.end();
      else fail();
    });
    if (r.signal.aborted) {
      abort();
      return;
    }
    child.stdin.end(lines.join("\n") + "\n");
  });
}
