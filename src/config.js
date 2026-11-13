import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
export const VERSION = "0.1.0-alpha.15";
export const DEFAULTS = {
  baseUrl: null,
  model: null,
  context: 262144,
  maxTokens: 131072,
  reasoningEffort: "xhigh",
  thinkingBudget: 0,
  thinking: false,
  temperature: 0.7,
  topP: 0.95,
  topK: 20,
};
export function configHome() {
  return path.resolve(
    process.env.HERMESDESK_AGENT_HOME ||
      path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), ".config"),
        "HermesDeskAgent",
      ),
  );
}
export function endpoint(value) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    throw Error(
      "Use HTTPS, or HTTP on localhost, without credentials, query or fragment.",
    );
  if (u.pathname.replace(/\/$/, "") !== "/v1")
    throw Error("The endpoint must end in /v1.");
  return u.origin + "/v1";
}
export function validateConfig(input) {
  const c = { ...DEFAULTS, ...input };
  c.baseUrl = c.baseUrl === null ? null : endpoint(c.baseUrl);
  if (
    c.model !== null &&
    (typeof c.model !== "string" || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(c.model))
  )
    throw Error("Invalid model ID.");
  for (const [k, min, max] of [
    ["context", 8192, 1048576],
    ["maxTokens", 1, 131072],
    ["thinkingBudget", 0, 131071],
    ["topK", 0, 1000],
  ])
    if (!Number.isInteger(c[k]) || c[k] < min || c[k] > max)
      throw Error(k + " must be an integer from " + min + " to " + max + ".");
  if (!["low", "medium", "xhigh"].includes(c.reasoningEffort))
    throw Error("reasoningEffort must be low, medium or xhigh.");
  if (c.thinkingBudget && c.thinkingBudget >= c.maxTokens)
    throw Error("Thinking budget must be below the total output limit.");
  if (c.maxTokens + 1024 >= c.context)
    throw Error(
      "Total output must leave at least 1024 context tokens for input.",
    );
  if (typeof c.thinking !== "boolean")
    throw Error("thinking must be true or false.");
  for (const [k, max] of [
    ["temperature", 2],
    ["topP", 1],
  ])
    if (
      typeof c[k] !== "number" ||
      !Number.isFinite(c[k]) ||
      c[k] < 0 ||
      c[k] > max
    )
      throw Error("Invalid " + k + ".");
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, c[k]]));
}
export function loadConfig(home = configHome()) {
  try {
    return validateConfig(
      JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")),
    );
  } catch (e) {
    if (e.code === "ENOENT") return { ...DEFAULTS };
    throw e;
  }
}
export function saveConfig(c, home = configHome()) {
  const value = validateConfig(c);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = path.join(home, "config.json");
  fs.writeFileSync(target + ".tmp", JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(target + ".tmp", target);
  return value;
}

export function projectSessionDir(home, cwd) {
  const canonical = fs.realpathSync.native(cwd);
  return path.join(
    home,
    "sessions",
    crypto
      .createHash("sha256")
      .update(
        process.platform === "win32" ? canonical.toLowerCase() : canonical,
      )
      .digest("hex")
      .slice(0, 24),
  );
}

export function supportedNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return (
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    (major > 22 || (major === 22 && minor >= 19))
  );
}
