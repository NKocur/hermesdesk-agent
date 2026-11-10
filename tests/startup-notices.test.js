import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/agent.js";
import { validateConfig } from "../src/config.js";
import { createInteractiveMode } from "../src/ui/interactive.js";

async function fixture(t) {
  const home = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "hd-sdk-notices-"),
    ),
    cwd = path.join(home, "work");
  fs.mkdirSync(cwd);
  const runtime = await createRuntime({
    home,
    cwd,
    token: "a".repeat(64),
    config: validateConfig({
      baseUrl: "http://127.0.0.1:9/v1",
      model: "fixture",
      maxTokens: 128,
    }),
  });
  t.after(async () => {
    await runtime.dispose();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return runtime;
}
function terminal() {
  return {
    columns: 100,
    rows: 30,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    write() {},
    drainInput: async () => {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  };
}

test("HermesDesk marks only the bundled SDK version seen and keeps telemetry disabled", async (t) => {
  const runtime = await fixture(t);
  const { VERSION: piVersion } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const settings = runtime.session.settingsManager;
  assert.equal(settings.getLastChangelogVersion(), piVersion);
  assert.equal(settings.getSettings().enableInstallTelemetry, false);
  assert.equal(settings.getSettings().enableAnalytics, false);
  assert.equal(settings.getSettings().quietStartup, "header");
});

test("HermesDesk uses Pi's supported skip flag so an upstream release never triggers a check or banner", async (t) => {
  const keys = ["PI_SKIP_VERSION_CHECK", "PI_OFFLINE"],
    previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  });
  delete process.env.PI_SKIP_VERSION_CHECK;
  delete process.env.PI_OFFLINE;
  const runtime = await fixture(t);
  const { VERSION: piVersion } = await import(
    "@earendil-works/pi-coding-agent"
  );
  // Inspect the installed pinned SDK's behavior without changing its files.
  const module = new URL(
    "./utils/version-check.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const { checkForNewPiVersion } = await import(module.href);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({
      version: "999.0.0",
      note: "An unrelated Pi release",
    });
  });
  assert.equal(
    (await checkForNewPiVersion(piVersion)).version,
    "999.0.0",
    "positive control would show Pi's update banner",
  );
  assert.equal(requests, 1);
  const ui = await createInteractiveMode(runtime, { terminal: terminal() });
  assert.ok(ui);
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, "1");
  assert.equal(
    process.env.PI_OFFLINE,
    undefined,
    "model/startup networking is not switched off",
  );
  assert.equal(await checkForNewPiVersion(piVersion), undefined);
  assert.equal(
    requests,
    1,
    "HermesDesk prevents the unrelated upstream version request",
  );
});
