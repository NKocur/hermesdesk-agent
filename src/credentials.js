import fs from "node:fs";
import { validateAccess } from "./connection.js";
import path from "node:path";
import { spawn } from "node:child_process";
const PS = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $r=([Console]::In.ReadToEnd() | ConvertFrom-Json); if ($r.action -eq 'protect') {$b=[Text.Encoding]::UTF8.GetBytes($r.value); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))} else {$b=[Convert]::FromBase64String($r.value); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))}`;
function dpapi(action, value) {
  if (process.platform !== "win32")
    throw Error(
      "Persistent key storage currently supports Windows. Use HERMESDESK_API_KEY for a session on other systems.",
    );
  return new Promise((resolve, reject) => {
    const p = spawn(
        path.join(
          process.env.SystemRoot || "C:/Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(PS, "utf16le").toString("base64"),
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      ),
      chunks = [];
    let length = 0;
    const timer = setTimeout(() => p.kill(), 15000);
    p.stdout.on("data", (b) => {
      length += b.length;
      if (length > 32768) p.kill();
      else chunks.push(b);
    });
    p.stderr.resume();
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8"))
        : reject(
            Error(
              "Windows could not unlock the saved credential for this user. Run hermesdesk connect again.",
            ),
          );
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify({ action, value }));
  });
}
export async function saveCredential(home, baseUrl, token, access) {
  if (!/^[A-Za-z0-9_-]{48,128}$/.test(token))
    throw Error("Enter the HermesDesk inference API key.");
  const encrypted = await dpapi(
    "protect",
    JSON.stringify({ baseUrl, token, access: validateAccess(access) }),
  );
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "credential.dpapi");
  fs.writeFileSync(file + ".tmp", encrypted, { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
export async function getCredential(home, baseUrl) {
  return (await getConnection(home, baseUrl)).token;
}
export async function getConnection(home, baseUrl) {
  const access =
    process.env.HERMESDESK_ACCESS_CLIENT_ID ||
    process.env.HERMESDESK_ACCESS_CLIENT_SECRET
      ? validateAccess({
          clientId: process.env.HERMESDESK_ACCESS_CLIENT_ID,
          clientSecret: process.env.HERMESDESK_ACCESS_CLIENT_SECRET,
        })
      : undefined;
  if (process.env.HERMESDESK_API_KEY)
    return { token: process.env.HERMESDESK_API_KEY, access };
  let encrypted;
  try {
    encrypted = fs.readFileSync(path.join(home, "credential.dpapi"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT")
      throw Error("Not connected. Run hermesdesk connect first.");
    throw e;
  }
  const value = JSON.parse(await dpapi("unprotect", encrypted));
  if (value.baseUrl !== baseUrl)
    throw Error(
      "This key belongs to a different endpoint. Run hermesdesk connect.",
    );
  return { token: value.token, access: access || validateAccess(value.access) };
}
export function logout(home) {
  fs.rmSync(path.join(home, "credential.dpapi"), { force: true });
}
export async function hiddenInput(label) {
  if (!process.stdin.isTTY)
    throw Error(
      "Run connect in an interactive terminal, or set HERMESDESK_API_KEY for a session.",
    );
  process.stdout.write(label);
  return new Promise((resolve, reject) => {
    let text = "";
    const old = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const done = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(old);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    function onData(chunk) {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          done();
          reject(Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          done();
          resolve(text.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
        else if (char >= " ") text += char;
        if (text.length > 8192) {
          done();
          reject(Error("Credential input is too long."));
          return;
        }
      }
    }
    process.stdin.on("data", onData);
  });
}
