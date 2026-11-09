/**
 * exec-runner.test.ts — the exec layer's TIME budgets.
 *
 * `run_command` has two modes with two completely different notions of "too long", and they
 * were sharing one number.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  execTimeoutMs,
} from "./exec-runner.js";

test("execTimeoutMs: a BACKGROUND job is budgeted as a lifetime, not as a turn stall", () => {
  /**
   * `mode` used to be read AFTER the timeout was computed, so both modes shared the foreground
   * constants and every detached job was killed at 30 seconds — `job_status` reporting
   * `timeout · exit 124` on a `sleep 120`, a dev server, or any long build. The 30s number is
   * how long a TURN may stall waiting for output; it says nothing about how long a job that
   * deliberately outlives its turn may live. The code even documented the intent one line
   * above the bug: "Backgrounding exists so a long command OUTLIVES the turn that started it".
   */
  assert.equal(execTimeoutMs("collect"), DEFAULT_EXEC_TIMEOUT_MS);
  assert.equal(execTimeoutMs("background"), DEFAULT_BACKGROUND_TIMEOUT_MS);
  assert.ok(
    execTimeoutMs("background") > execTimeoutMs("collect"),
    "backgrounding must not SHORTEN a job's life",
  );

  // an explicit ask is honoured in both modes...
  assert.equal(execTimeoutMs("collect", 5), 5_000);
  assert.equal(execTimeoutMs("background", 5), 5_000);
  // ...and clamped to each mode's OWN ceiling — a background job may outlive the foreground max
  assert.equal(execTimeoutMs("collect", 10_000), MAX_EXEC_TIMEOUT_MS);
  assert.equal(execTimeoutMs("background", 3600), 3_600_000);
  assert.equal(execTimeoutMs("background", 10 * 60 * 60), MAX_BACKGROUND_TIMEOUT_MS);
  // a nonsense ask falls back rather than becoming zero (which would kill the job instantly)
  assert.equal(execTimeoutMs("background", 0), DEFAULT_BACKGROUND_TIMEOUT_MS);
  assert.equal(execTimeoutMs("background", -1), DEFAULT_BACKGROUND_TIMEOUT_MS);
});

test("a pipeline whose tail exits early ends like a shell's: no EPIPE crash, no runaway head", async () => {
  /**
   * `yes | head -1`: head exits after one line. The next chunk `yes` wrote into head's closed
   * stdin raised EPIPE with no listener — an uncaughtException that ended the whole TUI session —
   * and nothing told `yes` to stop, so it ran until the 30 s timeout and reported exit 124.
   */
  const { parseCommand } = await import("../../exec/index.js");
  const { runParsedCommand } = await import("./exec-runner.js");
  const p = parseCommand("yes | head -1", { vars: {} });
  assert.ok(p.ok);
  let uncaught: unknown;
  const onUncaught = (e: unknown) => {
    uncaught = e;
  };
  process.on("uncaughtException", onUncaught);
  try {
    const ac = new AbortController();
    const r = await runParsedCommand(p.command, {
      cwd: process.cwd(),
      sandbox: { kind: "none", reason: "test" },
      timeoutMs: 10_000,
      signal: ac.signal,
    });
    assert.equal(r.stdout.trim(), "y");
    assert.equal(r.timedOut, false, "the head was stopped, not timed out");
    assert.equal(r.exitCode, 0);
    assert.ok(r.durationMs < 5_000, `took ${r.durationMs} ms`);
    // the turn's signal is no longer holding this pipeline's abort handler
    ac.abort();
    await new Promise((res) => setTimeout(res, 50));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.equal(uncaught, undefined, `uncaught: ${String(uncaught)}`);
});
