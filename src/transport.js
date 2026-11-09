import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import path from "node:path";
import { spawn } from "node:child_process";
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
    const challenge =
      r.status === 403 &&
      (r.headers.get("cf-mitigated") === "challenge" ||
        (r.headers.get("content-type") || "").includes("text/html"));
    const error = new Error(
      r.status === 401
        ? "API key is invalid, revoked or expired."
        : challenge
          ? "Cloudflare blocked this API request with a browser challenge. The server owner needs to adjust protection for the API endpoint."
          : "Model discovery failed (HTTP " + r.status + ").",
    );
    error.code = challenge ? "CLOUDFLARE_CHALLENGE" : "MODEL_DISCOVERY_FAILED";
    error.status = r.status;
    const ray = r.headers.get("cf-ray");
    if (ray && /^[A-Za-z0-9-]{1,100}$/.test(ray))
      error.message += " Cloudflare Ray: " + ray;
    throw error;
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
    let buffer = Buffer.alloc(0);
    let headersDone = false,
      settled = false,
      bodyClosed = false,
      controller;
    const stopChild = () => {
      child.stdout.pause();
      child.kill();
    };
    const finishBody = (error) => {
      if (bodyClosed) return;
      bodyClosed = true;
      if (controller) {
        if (error) controller.error(error);
        else controller.close();
      }
    };
    const writeBody = (chunk) => {
      if (bodyClosed || !controller || !chunk.length) return;
      controller.enqueue(chunk);
      if (controller.desiredSize <= 0) child.stdout.pause();
    };
    const abort = () => {
      const error = new DOMException("Request cancelled", "AbortError");
      finishBody(error);
      stopChild();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const fail = () => {
      if (bodyClosed) return;
      const error = new Error(
        "Windows HTTP transport failed" +
          (child.exitCode ? " (curl " + child.exitCode + ")" : "") +
          ". Check the server address and connection.",
      );
      finishBody(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    r.signal.addEventListener("abort", abort, { once: true });
    child.stderr.resume();
    child.on("error", fail);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      if (bodyClosed) return;
      if (headersDone) {
        writeBody(chunk);
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
          fail();
          stopChild();
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
        const noBody = [204, 205, 304].includes(status) || r.method === "HEAD";
        const body = noBody
          ? null
          : new ReadableStream({
              start(value) {
                controller = value;
              },
              pull() {
                if (!bodyClosed) child.stdout.resume();
              },
              cancel() {
                bodyClosed = true;
                r.signal.removeEventListener("abort", abort);
                stopChild();
              },
            });
        const response = new Response(body, { status, headers });
        Object.defineProperty(response, "url", { value: r.url });
        settled = true;
        resolve(response);
        writeBody(buffer);
        buffer = Buffer.alloc(0);
        break;
      }
      if (!headersDone && buffer.length > 65536) {
        fail();
        stopChild();
      }
    });
    child.on("close", (code) => {
      r.signal.removeEventListener("abort", abort);
      if (bodyClosed) return;
      if (code === 0 && headersDone) finishBody();
      else fail();
    });
    if (r.signal.aborted) {
      abort();
      return;
    }
    child.stdin.end(lines.join("\n") + "\n");
  });
}
