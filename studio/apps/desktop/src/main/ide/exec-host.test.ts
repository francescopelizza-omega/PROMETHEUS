/**
 * exec-host.test.ts — node:test for the one-shot command runner (real spawn).
 *
 * Mirrors git-host.test.ts: exercises the DEFAULT runner against harmless commands to
 * pin capture + exit-code semantics (it must resolve, never reject, for a non-zero exit).
 * Skips on win32 (the assertions use POSIX-shell command lines).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultExecRunner } from "./exec-host.js";

const POSIX = process.platform !== "win32";

test("captures stdout + exit 0 for a successful command", { skip: !POSIX }, async () => {
  const r = await defaultExecRunner("echo prometheus", process.cwd(), 10_000);
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /prometheus/);
});

test("resolves (not rejects) with the non-zero exit code", { skip: !POSIX }, async () => {
  const r = await defaultExecRunner("exit 3", process.cwd(), 10_000);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
});

test("captures stderr", { skip: !POSIX }, async () => {
  const r = await defaultExecRunner("echo oops 1>&2", process.cwd(), 10_000);
  assert.match(r.stderr, /oops/);
});

test("times out + SIGKILLs a hung command", { skip: !POSIX }, async () => {
  const r = await defaultExecRunner("sleep 5", process.cwd(), 300);
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
});
