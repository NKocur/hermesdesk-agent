import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/gateway.mjs";
const aud = "a".repeat(64),
  context = { access: { aud } };
const request = (jwt, path = "/v1/models", init = {}) =>
  new Request("https://worker.example" + path, {
    ...init,
    headers: {
      "cf-access-jwt-assertion": jwt,
      "cf-connecting-ip": "192.0.2.4",
      authorization: "Bearer " + "t".repeat(64),
      ...init.headers,
    },
  });
const config = { ACCESS_AUDIENCE: aud, GATEWAY_HOST: "models.example" };
async function signed() {
  return "forged-header-cannot-grant-access";
}
test("Worker rejects missing Access token and private routes before contacting the PC", async () => {
  let calls = 0;
  const env = {
    ...config,
    MODEL_GATEWAY: {
      fetch() {
        calls++;
      },
    },
    IP_LIMIT: { limit: async () => ({ success: true }) },
    KEY_LIMIT: { limit: async () => ({ success: true }) },
  };
  assert.equal((await worker.fetch(request(""), env)).status, 403);
  const jwt = await signed();
  for (const path of ["/api/config", "/v1/models?key=x", "/v1/%2fmodels"]) {
    assert.equal(
      (await worker.fetch(request(jwt, path), env, context)).status,
      404,
    );
  }
  assert.equal(
    (
      await worker.fetch(
        request(jwt, "/v1/models", {
          headers: { origin: "https://other.example" },
        }),
        env,
        context,
      )
    ).status,
    403,
  );
  assert.equal(calls, 0);
});
test("Worker strips privilege headers, honors limits and streams without buffering", async () => {
  let upstream;
  let cancelled = false;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(": ready\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const env = {
    ...config,
    IP_LIMIT: { limit: async () => ({ success: true }) },
    KEY_LIMIT: { limit: async () => ({ success: true }) },
    MODEL_GATEWAY: {
      async fetch(url, init) {
        upstream = { url, init };
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    },
  };
  const jwt = await signed();
  const response = await worker.fetch(
    request(jwt, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-household-key": "forged",
        cookie: "forged",
      },
      body: "{}",
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  assert.equal(upstream.url, "http://models.example/v1/chat/completions");
  for (const key of [
    "x-household-key",
    "cookie",
    "cf-access-jwt-assertion",
    "cf-access-client-secret",
  ])
    assert.equal(upstream.init.headers.has(key), false);
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /ready/);
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(
    (
      await worker.fetch(
        request(jwt),
        {
          ...env,
          IP_LIMIT: { limit: async () => ({ success: false }) },
        },
        context,
      )
    ).status,
    429,
  );
  assert.equal(
    (
      await worker.fetch(
        request(jwt),
        { ...env, MODEL_GATEWAY: undefined },
        context,
      )
    ).status,
    503,
  );
});

test("forged assertion headers cannot replace platform-verified Access context", async () => {
  const req = request("forged");
  const env = { ...config };
  assert.equal((await worker.fetch(req, env)).status, 403);
  assert.equal(
    (await worker.fetch(req, env, { access: { aud: "b".repeat(64) } })).status,
    403,
  );
});
