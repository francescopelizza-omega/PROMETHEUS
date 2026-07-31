/**
 * cli.test.ts — node:test smoke + unit tests for the prom CLI.
 *
 * Covers: the hand-rolled arg parser (global flags, two-word commands, aliases,
 * "--" passthrough), the verdict->exit-code mapping, and a LIVE smoke test of
 * `scan` against the real engine (skipped automatically when prometheus.py is
 * not present so the suite stays green on a bare checkout).
 *
 * Runnable after a plain tsc emit (node --test) OR directly under Node's
 * native type-stripping (node --test src/cli.test.ts). No test framework.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { dispatch } from "./index.js";
import { parseArgs } from "./parse.js";
import { parseSidecarObject } from "./sidecar.js";
import { exitCodeForTier } from "./verdict-view.js";

// ---- arg parser ----------------------------------------------------------- //

test("parseArgs: bare invocation -> REPL (file 11 §1)", () => {
  const p = parseArgs([]);
  assert.equal(p.repl, true);
  assert.equal(p.help, false);
  assert.deepEqual(p.command, []);
  // -h still short-circuits to help, not the REPL.
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["-h"]).repl, false);
});

test("parseArgs: single command", () => {
  const p = parseArgs(["scan"]);
  assert.deepEqual(p.command, ["scan"]);
  assert.equal(p.json, false);
  assert.equal(p.help, false);
});

test("parseArgs: gate with positional target", () => {
  const p = parseArgs(["gate", "/tmp/foo"]);
  assert.deepEqual(p.command, ["gate"]);
  assert.deepEqual(p.positionals, ["/tmp/foo"]);
});

test("parseArgs: --json is a global flag anywhere", () => {
  assert.equal(parseArgs(["--json", "scan"]).json, true);
  assert.equal(parseArgs(["scan", "--json"]).json, true);
});

test("parseArgs: --no-color global flag", () => {
  assert.equal(parseArgs(["scan", "--no-color"]).noColor, true);
});

test("parseArgs: two-word command 'model hw'", () => {
  const p = parseArgs(["model", "hw"]);
  assert.deepEqual(p.command, ["model", "hw"]);
});

test("parseArgs: two-word command 'provider list'", () => {
  const p = parseArgs(["provider", "list"]);
  assert.deepEqual(p.command, ["provider", "list"]);
});

test("parseArgs: alias ls -> list", () => {
  assert.deepEqual(parseArgs(["ls"]).command, ["list"]);
  assert.deepEqual(parseArgs(["model", "ls"]).command, ["model", "list"]);
});

test("parseArgs: env with no subcommand resolves to env", () => {
  assert.deepEqual(parseArgs(["env"]).command, ["env"]);
  assert.deepEqual(parseArgs(["env", "list"]).command, ["env", "list"]);
});

test("parseArgs: unknown command flags help", () => {
  const p = parseArgs(["frobnicate"]);
  assert.equal(p.help, true);
  assert.deepEqual(p.command, ["frobnicate"]);
});

test("parseArgs: -v/--version", () => {
  assert.equal(parseArgs(["-v"]).version, true);
  assert.equal(parseArgs(["--version"]).version, true);
});

test("parseArgs: '--' passthrough keeps tokens positional", () => {
  const p = parseArgs(["gate", "--", "--weird-target"]);
  assert.deepEqual(p.command, ["gate"]);
  assert.deepEqual(p.positionals, ["--weird-target"]);
});

test("parseArgs: --key=value captured in flags", () => {
  const p = parseArgs(["scan", "--only=claude"]);
  assert.equal(p.flags.only, "claude");
});

// ---- verdict exit-code mapping (C3) --------------------------------------- //

test("exitCodeForTier mirrors nemesis decision tiers", () => {
  assert.equal(exitCodeForTier("allow"), 0);
  assert.equal(exitCodeForTier("warn"), 10);
  assert.equal(exitCodeForTier("block"), 20);
  assert.equal(exitCodeForTier("error"), 2);
});

// ---- sidecar JSON recovery (last-to-first) -------------------------------- //

test("parseSidecarObject recovers object after a stray log line", () => {
  const out = 'loading env...\n{"ok":true,"command":"env.list","count":0}';
  const o = parseSidecarObject(out);
  assert.ok(o);
  assert.equal(o?.ok, true);
  assert.equal(o?.command, "env.list");
});

test("parseSidecarObject returns null on garbage", () => {
  assert.equal(parseSidecarObject("not json at all"), null);
  assert.equal(parseSidecarObject(""), null);
});

// ---- help/version dispatch (no engine) ------------------------------------ //

test("dispatch version --json", async () => {
  const out = await dispatch(parseArgs(["--version", "--json"]));
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { name: string }).name, "prom");
});

test("dispatch help is exit 0", async () => {
  const out = await dispatch(parseArgs(["help"]));
  assert.equal(out.exitCode, 0);
});

test("dispatch unknown command exits nonzero", async () => {
  const out = await dispatch(parseArgs(["frobnicate"]));
  assert.notEqual(out.exitCode, 0);
});

// ---- LIVE smoke: scan against the real engine (auto-skip) ----------------- //

const ENGINE_PY =
  process.env.PROMETHEUS_PY ?? "/Users/dev/ALPHA/PROMETHEUS/prometheus.py";

test(
  "smoke: prom scan returns an agents envelope from the real engine",
  { skip: existsSync(ENGINE_PY) ? false : `engine not found at ${ENGINE_PY}` },
  async () => {
    const out = await dispatch(parseArgs(["scan", "--json"]));
    assert.equal(out.exitCode, 0, "scan should exit 0 on a healthy engine");
    const env = out.json as { ok?: boolean; command?: string; agents?: unknown };
    assert.equal(env.ok, true);
    assert.equal(env.command, "scan");
    assert.ok(Array.isArray(env.agents), "scan envelope must carry agents[]");
  },
);

test(
  "smoke: prom env list returns environments from the sidecar (auto-skip)",
  {
    skip: existsSync("/Users/dev/ALPHA/PROMETHEUS/studio/python/sidecar/envmgr.py")
      ? false
      : "envmgr.py sidecar not found",
  },
  async () => {
    const out = await dispatch(parseArgs(["env", "list", "--json"]));
    const env = out.json as { ok?: boolean; environments?: unknown };
    assert.equal(env.ok, true);
    assert.ok(Array.isArray(env.environments));
  },
);
