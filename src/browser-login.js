import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import { endpoint } from "./config.js";
import { parseConnectionCode } from "./connection.js";
import { curlFetch, nativeFetch } from "./transport.js";
async function json(response) {
  const reader = response.body?.getReader();
  let text = "",
    size = 0;
  if (!reader) throw Error("Sign-in returned no response.");
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) {
      await reader.cancel();
      throw Error("Invalid sign-in response.");
    }
    text += new TextDecoder().decode(value);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Error("Invalid sign-in response.");
  }
}
export function browserMetadata(baseUrl, data) {
  const base = new URL(endpoint(baseUrl));
  let auth, token;
  try {
    auth = new URL(data.authorization_url);
    token = new URL(data.token_endpoint);
  } catch {
    throw Error("The server returned invalid browser sign-in settings.");
  }
  const local =
    base.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(base.hostname);
  if (
    data.version !== 1 ||
    auth.username ||
    auth.password ||
    auth.hash ||
    !(
      auth.protocol === "https:" ||
      (local && auth.protocol === "http:" && auth.hostname === "127.0.0.1")
    ) ||
    token.origin !== base.origin ||
    token.pathname !== "/auth/token" ||
    token.search ||
    token.hash ||
    token.username ||
    token.password
  )
    throw Error("The server returned unsafe browser sign-in settings.");
  return { authorization: auth, token };
}
export async function openBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
export async function browserLogin(
  baseUrl,
  {
    launch = openBrowser,
    log = console.log,
    timeoutMs = 300000,
    transport = process.platform === "win32" ? curlFetch : nativeFetch,
  } = {},
) {
  const base = new URL(endpoint(baseUrl));
  const info = await transport(base.origin + "/auth/info", {
    headers: { "User-Agent": "HermesDesk-CLI/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (info.status === 404) {
    await info.body?.cancel();
    return null;
  }
  if (info.status !== 200) {
    await info.body?.cancel();
    throw Error(
      "Browser sign-in is unavailable at this endpoint. Check the server address or use connect --code.",
    );
  }
  const metadata = browserMetadata(baseUrl, await json(info));
  const state = crypto.randomBytes(32).toString("base64url"),
    verifier = crypto.randomBytes(32).toString("base64url"),
    challenge = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
  let resolveCallback,
    rejectCallback,
    settled = false,
    callbackResponse;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = http.createServer((req, res) => {
    const fail = () => {
      res.writeHead(400, {
        "content-type": "text/plain",
        "cache-control": "no-store",
        connection: "close",
      });
      res.end("Invalid sign-in callback. Return to your terminal.");
    };
    if (
      settled ||
      req.method !== "GET" ||
      !["127.0.0.1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) ||
      req.headers.host !== "127.0.0.1:" + server.address().port ||
      req.url.length > 2048
    )
      return fail();
    let u;
    try {
      u = new URL(req.url, "http://127.0.0.1");
    } catch {
      return fail();
    }
    const denied =
      u.searchParams.getAll("error").length === 1 &&
      u.searchParams.get("error") === "access_denied" &&
      !u.searchParams.has("code");
    const validCode =
      !u.searchParams.has("error") &&
      u.searchParams.getAll("code").length === 1 &&
      /^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get("code") || "");
    if (
      u.pathname !== "/hermesdesk/callback" ||
      u.searchParams.getAll("state").length !== 1 ||
      u.searchParams.get("state") !== state ||
      [...u.searchParams.keys()].some(
        (k) => !["state", "code", "error"].includes(k),
      ) ||
      (!denied && !validCode)
    )
      return fail();
    settled = true;
    callbackResponse = res;
    if (denied) rejectCallback(Error("Browser sign-in canceled."));
    else resolveCallback(u.searchParams.get("code"));
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const redirectUri =
    "http://127.0.0.1:" + server.address().port + "/hermesdesk/callback";
  const authorization = new URL(metadata.authorization);
  for (const [key, value] of Object.entries({
    flow: "browser",
    state,
    challenge,
    redirect_uri: redirectUri,
    computer: os.hostname().slice(0, 80),
  }))
    authorization.searchParams.set(key, value);
  const timer = setTimeout(
    () =>
      rejectCallback(
        Error("Browser sign-in timed out. Run hermesdesk connect again."),
      ),
    timeoutMs,
  );
  try {
    log("Sign in and approve this computer in your browser.");
    log(
      "If the browser does not open, open this link on this computer:\n" +
        authorization.href,
    );
    Promise.resolve()
      .then(() => launch(authorization.href))
      .catch(() => {
        log("Automatic browser opening was unavailable; use the link above.");
      });
    const code = await callback;
    const response = await transport(metadata.token.href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "User-Agent": "HermesDesk-CLI/1.0",
      },
      body: JSON.stringify({ code, verifier, redirectUri }),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw Error(
        "Browser sign-in was not accepted or expired. Run connect again.",
      );
    }
    const value = parseConnectionCode((await json(response)).connectionCode);
    if (value.baseUrl !== endpoint(baseUrl))
      throw Error("Sign-in returned credentials for a different endpoint.");
    callbackResponse.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      connection: "close",
    });
    callbackResponse.end(
      "<!doctype html><title>HermesDesk connected</title><h1>Computer approved</h1><p>Return to your terminal to finish connecting. You can close this tab.</p>",
    );
    return value;
  } finally {
    clearTimeout(timer);
    if (callbackResponse && !callbackResponse.writableEnded) {
      callbackResponse.writeHead(400, {
        "content-type": "text/plain",
        connection: "close",
      });
      callbackResponse.end("Sign-in could not finish. Check your terminal.");
    }
    if (callbackResponse && !callbackResponse.writableFinished) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        callbackResponse.once("finish", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
