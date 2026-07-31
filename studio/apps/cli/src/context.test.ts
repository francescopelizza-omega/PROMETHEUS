/**
 * context.test.ts — CLI-084: the shared `--json` envelope + the ONE error→exit-code mapping.
 * Exercises the load-bearing 0/1/2 convention (a type-compiles assertion alone can't catch a
 * flipped ternary), and the `CommandJsonEnvelope` requires-`ok` constraint.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EngineError } from "@prometheus/engine-bridge";

import type { CommandOutcome } from "./context.js";
import { makeContext, outcomeFromError, suppressProgress } from "./context.js";
import { parseArgs } from "./parse.js";

test("CLI-084 outcomeFromError: a FAIL-CLOSED engine error → exit 2 (security/engine block)", () => {
  const out = outcomeFromError(EngineError.fromKind("timeout", "scan timed out"));
  assert.equal(out.exitCode, 2);
  assert.equal(out.json?.ok, false); // the envelope always carries ok
});

test("CLI-084 outcomeFromError: a NON-fail-closed engine error → its code (clamped), not a block", () => {
  const out = outcomeFromError(EngineError.fromKind("engine-error", "bad args", { exitCode: 1 }));
  assert.equal(out.exitCode, 1);
});

test("CLI-084 outcomeFromError: a bogus exitCode never wraps a FAIL to success (clamped ≥1)", () => {
  // an 8-bit wrap (256 → 0) or a negative would silently report success — clamp to 1.
  const wrap = outcomeFromError(EngineError.fromKind("engine-error", "x", { exitCode: 256 }));
  assert.equal(wrap.exitCode, 1);
  const neg = outcomeFromError(EngineError.fromKind("engine-error", "x", { exitCode: -3 }));
  assert.equal(neg.exitCode, 1);
});

test("CLI-084 outcomeFromError: a generic thrown error → exit 1 with the message", () => {
  const out = outcomeFromError(new Error("boom"));
  assert.equal(out.exitCode, 1);
  assert.equal(out.json?.ok, false);
  assert.match(String(out.json?.error), /boom/);
});

test("CLI-084 CommandJsonEnvelope: json REQUIRES ok; extra fields ride alongside", () => {
  const good: CommandOutcome = { json: { ok: true, entries: [1, 2] }, exitCode: 0 };
  assert.equal(good.json?.ok, true);
  assert.deepEqual(good.json?.entries, [1, 2]);
  // @ts-expect-error — a json payload WITHOUT `ok` is a compile error (the envelope constraint).
  const bad: CommandOutcome = { json: { entries: [] }, exitCode: 1 };
  void bad;
});

/* ── CLI-085: --quiet/-q wiring ─────────────────────────────────────────────────── */

test("CLI-085 makeContext lifts --quiet / -q into ctx.quiet", () => {
  assert.equal(makeContext(parseArgs(["scan", "x"])).quiet, false); // default
  assert.equal(makeContext(parseArgs(["--quiet", "scan", "x"])).quiet, true);
  assert.equal(makeContext(parseArgs(["-q", "scan", "x"])).quiet, true);
});

test("CLI-085 suppressProgress: chatter is muted under --json OR --quiet, else shown", () => {
  assert.equal(suppressProgress({ json: false, quiet: false }), false); // interactive → show progress
  assert.equal(suppressProgress({ json: false, quiet: true }), true); // --quiet mutes it
  assert.equal(suppressProgress({ json: true, quiet: false }), true); // --json keeps stdout clean
  assert.equal(suppressProgress({ json: true, quiet: true }), true); // --quiet --json → still muted
});
