import assert from "node:assert/strict";
import { dirname, join } from "node:path";
/**
 * engine.test.ts — PrometheusEngine facade (file 02 §3.4):
 *   - buildInstallArgv / buildUninstallArgv lower a typed request to argv with
 *     GLOBAL FLAGS FIRST (--dry-run/--yes/--strict/--force), then the subcommand,
 *     then sub-flags (--only, --host repeated). dryRun defaults TRUE.
 *   - the facade reuses createEngineClient (asClient) over the same config.
 *   - a typed method round-trips a real envelope through a fake engine.
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PrometheusEngine,
  buildInstallArgv,
  buildUninstallArgv,
  createPrometheusEngine,
} from "./engine.js";
import { isCommand } from "./types/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = join(HERE, "__fixtures__", "fake-engine.mjs");

test("buildInstallArgv: defaults dryRun TRUE, flags BEFORE subcommand", () => {
  assert.deepEqual(buildInstallArgv({ name: "caveman" }), ["--dry-run", "install", "caveman"]);
});

test("buildInstallArgv: full flag set + hosts -> repeated --host AFTER name", () => {
  assert.deepEqual(
    buildInstallArgv({
      name: "superpowers",
      dryRun: false,
      yes: true,
      strict: true,
      force: true,
      only: "core",
      hosts: ["claude", "cursor"],
    }),
    [
      "--yes",
      "--strict",
      "--force",
      "install",
      "superpowers",
      "--only",
      "core",
      "--host",
      "claude",
      "--host",
      "cursor",
    ],
  );
});

test("buildUninstallArgv: dryRun TRUE default, no force/strict path", () => {
  assert.deepEqual(buildUninstallArgv({ name: "caveman" }), ["--dry-run", "uninstall", "caveman"]);
  assert.deepEqual(
    buildUninstallArgv({ name: "caveman", dryRun: false, yes: true, hosts: ["claude"] }),
    ["--yes", "uninstall", "caveman", "--host", "claude"],
  );
});

test("PrometheusEngine.asClient() returns a working EngineClient (no breakage)", () => {
  const eng = createPrometheusEngine();
  const client = eng.asClient();
  assert.equal(typeof client.scan, "function");
  assert.equal(typeof client.install, "function");
  assert.equal(typeof client.gate, "function");
  assert.equal(typeof client.version, "function");
});

test("PrometheusEngine.install(): round-trips a typed InstallEnvelope via fake engine", async () => {
  const eng = new PrometheusEngine({ pythonBin: process.execPath, prometheusPy: FAKE_ENGINE });
  const env = await eng.install({ name: "caveman" });
  assert.ok(isCommand(env, "install"));
  if (isCommand(env, "install")) {
    assert.equal(env.command, "install");
    assert.equal(env.ok, true);
    assert.equal(env.request.plugin, "caveman");
  }
});

test("PrometheusEngine.scan(): round-trips through the fake engine", async () => {
  const eng = new PrometheusEngine({ pythonBin: process.execPath, prometheusPy: FAKE_ENGINE });
  const env = await eng.scan();
  assert.equal(env.command, "scan");
  assert.equal(env.ok, true);
});
