import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { browserLogin, browserMetadata } from "../src/browser-login.js";
const base = "https://models.example/v1",
  info = {
    version: 1,
    authorization_url: "https://desk.example/?connect=hermesdesk-agent",
    token_endpoint: "https://models.example/auth/token",
  };
const access = {
    clientId: "fixture-client-id.access",
    clientSecret: "s".repeat(64),
  },
  token = "t".repeat(64);
const bundle =
  "hdc1_" +
  Buffer.from(
    JSON.stringify({
      v: 1,
      baseUrl: base,
      token,
      access,
      expires: Date.now() + 60000,
    }),
  ).toString("base64url");
test("browser metadata never redirects credential exchange to another origin", () => {
  assert.equal(
    browserMetadata(base, info).token.origin,
    "https://models.example",
  );
  for (const patch of [
    { token_endpoint: "https://evil.example/auth/token" },
    { token_endpoint: "https://models.example/auth/token?x=1" },
    { authorization_url: "http://desk.example/" },
    { authorization_url: "https://user:password@desk.example/" },
  ])
    assert.throws(() => browserMetadata(base, { ...info, ...patch }));
});
test("browser login binds callback state and exchanges a private PKCE verifier only over HTTPS", async () => {
  let approval,
    callbackRead,
    exchanges = 0;
  const logs = [];
  const transport = async (url, init) => {
    if (url.endsWith("/auth/info")) return Response.json(info);
    exchanges++;
    assert.equal(url, info.token_endpoint);
    const body = JSON.parse(init.body);
    assert.equal(
      crypto.createHash("sha256").update(body.verifier).digest("base64url"),
      approval.searchParams.get("challenge"),
    );
    assert.equal(body.redirectUri, approval.searchParams.get("redirect_uri"));
    assert.equal(body.code, "c".repeat(43));
    assert.ok(!approval.href.includes(body.verifier));
    return Response.json({ connectionCode: bundle });
  };
  const result = await browserLogin(base, {
    transport,
    log: (s) => logs.push(s),
    timeoutMs: 3000,
    launch: async (url) => {
      approval = new URL(url);
      const target = new URL(approval.searchParams.get("redirect_uri"));
      target.searchParams.set("state", "wrong");
      target.searchParams.set("code", "c".repeat(43));
      const wrong = await fetch(target);
      assert.equal(wrong.status, 400);
      await wrong.text();
      target.searchParams.set("state", approval.searchParams.get("state"));
      callbackRead = fetch(target).then(async (r) => {
        assert.equal(r.status, 200);
        assert.match(await r.text(), /Computer approved/);
      });
      await callbackRead;
    },
  });
  await callbackRead;
  assert.equal(result.token, token);
  assert.deepEqual(result.access, access);
  assert.equal(exchanges, 1);
  assert.ok(!logs.join().includes(bundle));
  assert.ok(!logs.join().includes(access.clientSecret));
});
test("browser sign-in times out without requesting or saving credentials", async () => {
  await assert.rejects(
    browserLogin(base, {
      transport: async () => Response.json(info),
      launch: async () => {},
      log: () => {},
      timeoutMs: 30,
    }),
    /timed out/,
  );
});

test("browser cancellation ends sign-in without exchanging credentials", async () => {
  let attempts = 0;
  await assert.rejects(
    browserLogin(base, {
      timeoutMs: 3000,
      log: () => {},
      transport: async () => {
        attempts++;
        return Response.json(info);
      },
      launch: async (url) => {
        const auth = new URL(url),
          target = new URL(auth.searchParams.get("redirect_uri"));
        target.searchParams.set("state", auth.searchParams.get("state"));
        target.searchParams.set("error", "access_denied");
        const response = await fetch(target);
        await response.text();
      },
    }),
    /canceled/,
  );
  assert.equal(attempts, 1);
});
