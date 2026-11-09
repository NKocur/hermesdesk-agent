const MAX_BYTES = 2 * 1024 * 1024;
const secureHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000",
  "referrer-policy": "no-referrer",
};
function failure(status, message) {
  return Response.json(
    { error: { message, type: "worker_access_error" } },
    { status, headers: secureHeaders },
  );
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return failure(403, "HTTPS is required.");
    if (
      !/^[a-f0-9]{64}$/.test(env.ACCESS_AUDIENCE || "") ||
      ctx?.access?.aud !== env.ACCESS_AUDIENCE
    )
      return failure(403, "Cloudflare Access authentication required.");
    if (
      !env.IP_LIMIT ||
      !env.KEY_LIMIT ||
      !env.MODEL_GATEWAY ||
      !/^[-a-z0-9]+(?:\.[-a-z0-9]+)+$/.test(env.GATEWAY_HOST || "")
    )
      return failure(503, "Model gateway is unavailable.");
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip || !/^[0-9a-fA-F:.]{3,45}$/.test(ip))
      return failure(403, "Client identity unavailable.");
    if (!(await env.IP_LIMIT.limit({ key: ip })).success)
      return failure(429, "Request rate exceeded.");
    if (request.headers.has("origin")) return failure(403, "API clients only.");
    const allowed =
      (request.method === "GET" && url.pathname === "/v1/models") ||
      (request.method === "POST" && url.pathname === "/v1/chat/completions");
    if (!allowed || url.search || url.hash) return failure(404, "Not found.");
    const auth = /^Bearer ([A-Za-z0-9_-]{48,128})$/.exec(
      request.headers.get("authorization") || "",
    );
    if (!auth) return failure(401, "A model API key is required.");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(auth[1]),
    );
    const hex = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (!(await env.KEY_LIMIT.limit({ key: hex })).success)
      return failure(429, "Model request rate exceeded.");
    let body;
    if (request.method === "POST") {
      if (
        !/^application\/json(?:;|$)/i.test(
          request.headers.get("content-type") || "",
        )
      )
        return failure(415, "Use application/json.");
      const size = request.headers.get("content-length");
      if (size && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES))
        return failure(413, "Request exceeds 2 MB.");
      const reader = request.body?.getReader();
      if (!reader) return failure(400, "A request body is required.");
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > MAX_BYTES) {
            await reader.cancel();
            return failure(413, "Request exceeds 2 MB.");
          }
          chunks.push(value);
        }
      } catch {
        return failure(400, "Request body could not be read.");
      }
      body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
    }
    const headers = new Headers({
      authorization: request.headers.get("authorization"),
      accept: "application/json, text/event-stream",
      "user-agent": "HermesDesk-Worker/1.0",
    });
    if (body) headers.set("content-type", "application/json");
    headers.set("cf-connecting-ip", ip);
    // Only this fixed host header and the single VPC Service's host/port can be used.
    try {
      const response = await env.MODEL_GATEWAY.fetch(
        "http://" + env.GATEWAY_HOST + url.pathname,
        {
          method: request.method,
          headers,
          body,
          redirect: "manual",
          signal: request.signal,
        },
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return failure(502, "Unexpected upstream redirect.");
      }
      const type = response.headers.get("content-type") || "";
      if (!/^(?:application\/json|text\/event-stream)(?:;|$)/i.test(type)) {
        await response.body?.cancel();
        return failure(502, "Unexpected gateway response.");
      }
      return new Response(response.body, {
        status: response.status,
        headers: {
          ...secureHeaders,
          "content-type": type,
          "x-hermesdesk-route": "private-vpc",
        },
      });
    } catch {
      return failure(503, "Private model gateway is unavailable.");
    }
  },
};
