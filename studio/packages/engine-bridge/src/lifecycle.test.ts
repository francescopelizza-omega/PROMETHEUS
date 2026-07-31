import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * lifecycle.test.ts — the state-changing catalog client (file 06 §4.2 / §8):
 *
 *   1) ARGV CONTRACT (echo fixture, no state change): every builder emits the EXACT argv
 *      the engine argparse accepts — GLOBAL flags (--dry-run/--yes/--strict/--force)
 *      BEFORE the subcommand (C2), --host repeatable, --only/--skip/--arm/--component
 *      after it. install() defaults dryRun:true (preview first, file 06 §8 / MCP) and
 *      emits --force ONLY when force:true is explicitly passed (C5 / the bridge refuses
 *      to force silently).
 *   2) LIVE GATE (REAL prometheus.py): a dry-run install of a real registry plugin reaches
 *      the engine and returns a verdict envelope — a BLOCK is a RETURNED value (ok:false /
 *      install_events with result:"blocked"), never a throw; JS never decides "safe" (C5).
 *
 * The argv tests run the fixture as the "pythonBin" via EngineConfig (pythonBin=node,
 * prometheusPy=fixture); no real plugin is touched. The LIVE test skips if the engine
 * is absent.
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { EngineConfig } from "./config.js";
import { type LifecycleClient, createLifecycleClient } from "./lifecycle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO = join(HERE, "__fixtures__", "echo-argv-engine.mjs");
// the REAL engine at the sibling PROMETHEUS root (…/studio/packages/engine-bridge/src -> up 4).
const REAL_ENGINE = join(HERE, "..", "..", "..", "..", "prometheus.py");

/** A client whose "python" is node and whose "prometheus.py" is the echo fixture. */
function echoClient(): LifecycleClient {
  const config: EngineConfig = { pythonBin: process.execPath, prometheusPy: ECHO };
  return createLifecycleClient({ config });
}

/** Pull the echoed argv off the returned envelope. */
function argvOf(env: { argvEcho?: unknown }): string[] {
  assert.ok(Array.isArray(env.argvEcho), "the echo fixture must return argvEcho[]");
  return (env.argvEcho as unknown[]).map(String);
}

test("install() defaults to dry-run-first; global flags precede the subcommand", async () => {
  const env = await echoClient().install("claude-mem");
  const argv = argvOf(env);
  // --dry-run is a GLOBAL flag → must come BEFORE the "install" subcommand (C2).
  assert.deepEqual(argv, ["--dry-run", "install", "claude-mem"]);
});

test("install() with surgical + arm + host options builds the exact argv", async () => {
  const env = await echoClient().install("codegraph", {
    dryRun: false,
    yes: true,
    host: ["claude", "cursor"],
    only: "security-review,pr-bot",
    arm: true,
  });
  const argv = argvOf(env);
  // globals first (--yes), then subcommand + name, then --host (repeated) + --only + --arm.
  assert.deepEqual(argv, [
    "--yes",
    "install",
    "codegraph",
    "--host",
    "claude",
    "--host",
    "cursor",
    "--only",
    "security-review,pr-bot",
    "--arm",
  ]);
});

test("install() emits --force ONLY when force:true is explicit (C5 — never silent)", async () => {
  const withForce = argvOf(
    await echoClient().install("x", { dryRun: false, yes: true, force: true }),
  );
  assert.ok(withForce.includes("--force"), "force:true emits the global --force");
  // --force is a GLOBAL flag → it precedes the "install" subcommand (alongside --yes).
  assert.ok(
    withForce.indexOf("--force") < withForce.indexOf("install"),
    "the global --force precedes the subcommand",
  );

  const without = argvOf(await echoClient().install("x", { dryRun: false, yes: true }));
  assert.ok(!without.includes("--force"), "no force flag without an explicit force:true");
});

test("install() with --skip builds the EXCEPT-these surgical form", async () => {
  const argv = argvOf(
    await echoClient().install("graphify", { dryRun: false, yes: true, skip: "noisy-hook" }),
  );
  assert.deepEqual(argv, ["--yes", "install", "graphify", "--skip", "noisy-hook"]);
});

test("uninstall() defaults dry-run-first with host/only/skip", async () => {
  const argv = argvOf(await echoClient().uninstall("claude-mem", { host: "cursor", skip: "x" }));
  assert.deepEqual(argv, [
    "--dry-run",
    "uninstall",
    "claude-mem",
    "--host",
    "cursor",
    "--skip",
    "x",
  ]);
});

test("enable()/disable() build name + --only + --component + --host", async () => {
  const en = argvOf(await echoClient().enable("codegraph", { component: "mcp", host: "claude" }));
  assert.deepEqual(en, ["enable", "codegraph", "--component", "mcp", "--host", "claude"]);

  const dis = argvOf(await echoClient().disable("codegraph", { only: "hooks-x" }));
  assert.deepEqual(dis, ["disable", "codegraph", "--only", "hooks-x"]);
});

test("bundle() is the one-run official install with optional --host", async () => {
  assert.deepEqual(argvOf(await echoClient().bundle()), ["bundle"]);
  assert.deepEqual(argvOf(await echoClient().bundle({ host: "claude" })), [
    "bundle",
    "--host",
    "claude",
  ]);
});

test("sync() replicates a skill to other agents", async () => {
  const argv = argvOf(await echoClient().sync("cavecrew", { to: "cursor,codex" }));
  assert.deepEqual(argv, ["sync", "cavecrew", "--to", "cursor,codex"]);
});

test("scaffoldSkill() maps trigger→--description and autoFire:false→--manual", async () => {
  const auto = argvOf(
    await echoClient().scaffoldSkill("my-skill", { trigger: "Use when X", body: "do Y" }),
  );
  assert.deepEqual(auto, [
    "scaffold-skill",
    "my-skill",
    "--description",
    "Use when X",
    "--body",
    "do Y",
  ]);

  const manual = argvOf(await echoClient().scaffoldSkill("m", { autoFire: false }));
  assert.deepEqual(manual, ["scaffold-skill", "m", "--manual"]);
});

test("apps()/worldsim()/models() build the 4th/8th/3rd-fn lifecycle argv", async () => {
  const c = echoClient();
  assert.deepEqual(argvOf(await c.apps("install", "yt-dlp", { path: "/tmp/a" })), [
    "apps",
    "install",
    "yt-dlp",
    "--path",
    "/tmp/a",
  ]);
  assert.deepEqual(argvOf(await c.apps("rollback", "n8n", { version: "3" })), [
    "apps",
    "rollback",
    "n8n",
    "--version",
    "3",
  ]);
  assert.deepEqual(argvOf(await c.worldsim("restart", "mirofish")), [
    "worldsim",
    "restart",
    "mirofish",
  ]);
  assert.deepEqual(argvOf(await c.models("install", "airllm")), ["models", "install", "airllm"]);
});

test("LIVE GATE: a dry-run install reaches the REAL engine and returns a verdict envelope", async (t) => {
  if (!existsSync(REAL_ENGINE)) {
    t.skip(`prometheus.py not present at ${REAL_ENGINE}`);
    return;
  }
  const client = createLifecycleClient({ timeoutMs: 180_000 });
  // dry-run install of a real registry plugin — the engine runs nemesis and returns a
  // verdict envelope. We assert the WIRE roundtrips (command echoed, a request/results
  // payload), NOT a specific verdict (which depends on the live threat DB). A BLOCK is a
  // returned value (ok:false) — never a throw (C5).
  const env = await client.install("caveman", { dryRun: true });
  assert.equal(env.command, "install");
  assert.ok(
    "request" in env || "results" in env || "error" in env,
    "a verdict/plan envelope rode back",
  );
});
