/**
 * cli.test.ts — node:test smoke + unit tests for the prometheus CLI.
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

/**
 * Regression: "nemesis" was missing from ONE_WORD, so it fell into the "unknown command" branch
 * (help:true) — and since "nemesis" IS a real registered CommandSpec id, dispatch() rendered its
 * help synopsis (exit 0, json {ok:true}) instead of ever routing to the real command, which calls
 * client.gate(). The "FREE nemesis threat scan" never actually scanned anything, for any input.
 */
test("parseArgs: nemesis is a recognized ONE_WORD command, not an 'unknown command' help fallthrough", () => {
  const p = parseArgs(["nemesis", "owner/repo"]);
  assert.equal(p.help, false);
  assert.deepEqual(p.command, ["nemesis"]);
  assert.deepEqual(p.positionals, ["owner/repo"]);
});

/**
 * Regression: a mistyped second word for a TWO_WORD command (e.g. "secure trussed") used to be
 * silently absorbed into positionals with no trace that it was an attempted (invalid) subcommand
 * — indistinguishable from the user having typed no subcommand at all. `unmatchedSub` preserves
 * that word so a command's own switch can report it as unknown instead of silently defaulting.
 */
test("parseArgs: an invalid TWO_WORD subcommand is preserved as unmatchedSub, not silently dropped", () => {
  const p = parseArgs(["secure", "trussed"]);
  assert.deepEqual(p.command, ["secure"]);
  assert.equal(p.unmatchedSub, "trussed");
  assert.deepEqual(p.positionals, ["trussed"]); // unchanged — existing positional semantics preserved

  // a genuinely bare command (no second word at all) leaves unmatchedSub unset.
  assert.equal(parseArgs(["secure"]).unmatchedSub, undefined);
  // a VALID second word also leaves it unset.
  assert.equal(parseArgs(["secure", "trust", "list"]).unmatchedSub, undefined);
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
  assert.equal((out.json as { name: string }).name, "prometheus");
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

/** The repo root, walked from this file: …/studio/apps/cli/src → up 4. Relative, never
 *  an absolute developer path — those leak a username and only resolve on one machine. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const ENGINE_PY = process.env.PROMETHEUS_PY ?? join(REPO_ROOT, "prometheus.py");

test(
  "smoke: prometheus scan returns an agents envelope from the real engine",
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
  "smoke: prometheus env list returns environments from the sidecar (auto-skip)",
  {
    skip: existsSync(join(REPO_ROOT, "studio", "python", "sidecar", "envmgr.py"))
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

test("a MISTYPED command is reported as a command, not as an unknown help topic", async () => {
  /**
   * `parse.ts` marks an unknown verb with `help = true` so callers print usage — which left the
   * dispatcher unable to tell `prometheus keys` from `prometheus keys --help`. It looked the typo
   * up as a HELP TOPIC, so a user who mistyped a command was told about a help system they never
   * invoked, and offered the nearest topic instead of the nearest command.
   */
  const bad = await dispatch(parseArgs(["nosuchverb"]));
  assert.equal(bad.exitCode, 1);
  assert.match(bad.text ?? "", /unknown command: nosuchverb/);
  assert.equal((bad.json as { error?: string }).error, "unknown-command");

  // an explicit help request for a missing TOPIC keeps its own, correct wording
  const topic = await dispatch(parseArgs(["help", "nosuchtopic"]));
  assert.match(topic.text ?? "", /unknown help topic: nosuchtopic/);

  // and a real command is unaffected
  const good = await dispatch(parseArgs(["keymap"]));
  assert.equal(good.exitCode, 0);
});

test("no source file smuggles a RAW control byte where an escape belongs", () => {
  /**
   * A regex class written with literal bytes — `/[<NUL>-<US><DEL>]/` instead of
   * `/[\x00-\x1f\x7f]/` — behaves identically at runtime, so nothing failed. What it breaks is
   * every tool that reads the file as text: a NUL makes grep and ripgrep classify the source as
   * BINARY and skip it silently. Twenty-three files were affected, among them the entire
   * renderer-arg validation layer (validate.ts, arg-guards.ts, env-validate.ts, ide-validate.ts,
   * metadata-validate.ts), the secrets keychain, git-host, sql-host and pr-gateway.
   *
   * The failure mode is a search that returns nothing and looks like an answer: grepping
   * arg-guards.ts for its own exports printed zero matches, which reads as "this module exports
   * nothing" rather than "this file was skipped". Code review sees the same thing — git renders
   * a NUL-bearing file as binary — so the least-trusted-input validators were the least
   * reviewable files in the repo.
   *
   * Tab, newline and CR are ordinary text and stay exempt.
   */
  const offenders: string[] = [];
  // build output, vendored downloads and the python runtime staging tree are not our source.
  const skipDirs = new Set([
    "node_modules",
    "dist",
    "out",
    ".git",
    ".turbo",
    ".vscode-test",
    "coverage",
    "staging",
  ]);
  const exts = new Set([".ts", ".tsx", ".js", ".mjs", ".py"]);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      const p = join(dir, entry.name);
      if (!exts.has(extname(p))) continue;
      const buf = readFileSync(p);
      for (const byte of buf) {
        if (
          byte <= 0x08 ||
          byte === 0x0b ||
          byte === 0x0c ||
          (byte >= 0x0e && byte <= 0x1f) ||
          byte === 0x7f
        ) {
          offenders.push(
            `${p.slice(REPO_ROOT.length + 1)} (byte 0x${byte.toString(16).padStart(2, "0")})`,
          );
          break;
        }
      }
    }
  };
  walk(join(REPO_ROOT, "studio"));

  assert.deepEqual(
    offenders,
    [],
    `write these as \\xNN escapes so the file stays searchable:\n  ${offenders.join("\n  ")}`,
  );
});
