import { endpoint } from "./config.js";
export function validateAccess(access) {
  if (access == null) return undefined;
  if (
    !access ||
    typeof access !== "object" ||
    !/^[A-Za-z0-9_-]{8,128}\.access$/.test(access.clientId || "") ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(access.clientSecret || "")
  )
    throw Error(
      "Invalid Cloudflare Access credentials. Create a new connection code in HermesDesk.",
    );
  return { clientId: access.clientId, clientSecret: access.clientSecret };
}
export function parseConnectionCode(code) {
  if (typeof code !== "string" || !/^hdc1_[A-Za-z0-9_-]{1,8000}$/.test(code))
    throw Error(
      "Paste the private connection code from HermesDesk Settings > Connect coding tools.",
    );
  let value;
  try {
    value = JSON.parse(
      Buffer.from(code.slice(5), "base64url").toString("utf8"),
    );
  } catch {
    throw Error("The connection code is invalid.");
  }
  if (
    !value ||
    value.v !== 1 ||
    !/^[A-Za-z0-9_-]{48,128}$/.test(value.token || "") ||
    !Number.isFinite(value.expires) ||
    value.expires <= Date.now()
  )
    throw Error(
      "The connection code is expired or invalid. Create a new connection in HermesDesk.",
    );
  const baseUrl = endpoint(value.baseUrl);
  if (!baseUrl.startsWith("https://"))
    throw Error("Connection codes require HTTPS.");
  const access = validateAccess(value.access);
  if (!access)
    throw Error("Connection code is missing Cloudflare Access credentials.");
  return { baseUrl, token: value.token, access };
}
