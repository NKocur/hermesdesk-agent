import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { parseConnectionCode, validateAccess } from "../src/connection.js";
import { saveCredential, getConnection } from "../src/credentials.js";
import { modelFetch } from "../src/transport.js";
const access = {
    clientId: "fixture-client-id.access",
    clientSecret: "s".repeat(64),
  },
  token = "t".repeat(64);
const encode = (value) =>
  "hdc1_" + Buffer.from(JSON.stringify(value)).toString("base64url");
const bundle = {
  v: 1,
  baseUrl: "https://models.example/v1",
  token,
  access,
  expires: Date.now() + 60000,
};
test("connection codes validate expiry, endpoint and all credentials", () => {
  assert.deepEqual(parseConnectionCode(encode(bundle)), {
    baseUrl: bundle.baseUrl,
    token,
    access,
  });
  for (const patch of [
    { v: 2 },
    { expires: 0 },
    { baseUrl: "http://example/v1" },
    { baseUrl: "https://user:pass@example/v1" },
    { token: "short" },
    { access: null },
    { access: { ...access, clientSecret: "bad\r\nheader" } },
  ])
    assert.throws(() => parseConnectionCode(encode({ ...bundle, ...patch })));
  assert.throws(() => parseConnectionCode("garbage"));
  assert.throws(() =>
    validateAccess({ clientId: "bad", clientSecret: "s".repeat(64) }),
  );
});
test(
  "Access credentials stay encrypted and bound to the saved endpoint",
  { skip: process.platform !== "win32" },
  async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-access-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    await saveCredential(home, bundle.baseUrl, token, access);
    const raw = fs.readFileSync(path.join(home, "credential.dpapi"), "utf8");
    for (const secret of [token, access.clientId, access.clientSecret])
      assert.ok(!raw.includes(secret));
    assert.deepEqual(await getConnection(home, bundle.baseUrl), {
      token,
      access,
    });
    await assert.rejects(
      getConnection(home, "https://other.example/v1"),
      /different endpoint/,
    );
  },
);
test("Access headers reach only the configured model origin and redirects are not followed", async (t) => {
  let received,
    hits = 0;
  const server = http.createServer((q, r) => {
    received = q.headers;
    hits++;
    if (q.url.endsWith("/models"))
      r.writeHead(302, { location: "https://untrusted.example/v1/models" });
    r.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = "http://127.0.0.1:" + server.address().port + "/v1",
    fetcher = modelFetch(base, access);
  const response = await fetcher(base + "/models", {
    headers: { authorization: "Bearer " + token },
  });
  assert.equal(response.status, 302);
  await response.body?.cancel();
  assert.equal(received["cf-access-client-id"], access.clientId);
  assert.equal(received["cf-access-client-secret"], access.clientSecret);
  assert.equal(hits, 1);
  assert.throws(
    () => fetcher("https://untrusted.example/v1/models"),
    /Unexpected/,
  );
  assert.throws(() => fetcher(base + "/../api/config"), /Unexpected/);
});
