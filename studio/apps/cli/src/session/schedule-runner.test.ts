/**
 * schedule-runner.test.ts — the pass that executes DUE scheduled tasks.
 *
 * Uses a REAL temp directory (mkdtempSync) for `home` so the round-trip through the real
 * schedule-store.ts is exercised honestly — never the real `~/.prometheus`, per the standing
 * rule that a store/persistence function is never called with its default path omitted from a
 * test. `runOneShot` itself is always faked: no real model is spawned.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { agent } from "@prometheus/core";

import type { ParsedArgs } from "../parse.js";
import type { OneShotResult } from "./one-shot.js";
import type { ScheduleRunnerDeps } from "./schedule-runner.js";
import { runDueSchedules } from "./schedule-runner.js";
import { loadSchedules, upsertTask } from "./schedule-store.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "prometheus-schedule-runner-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function task(overrides: Partial<agent.ScheduledTask> = {}): agent.ScheduledTask {
  return {
    id: "t1",
    name: "summarize commits",
    cronExpr: "* * * * *", // matches every minute — always due when enabled
    task: "summarize today's commits",
    autonomy: "readonly",
    enabled: true,
    createdIso: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

function okResult(over: Partial<OneShotResult> = {}): OneShotResult {
  return { ok: true, reply: "done", toolCalls: ["read_file"], capped: false, ...over };
}

/** A fixed clock so `isDue`'s cron match and the recorded timestamps are deterministic. */
const FIXED_NOW = Date.UTC(2026, 7, 18, 12, 0, 0); // 2026-08-18T12:00:00.000Z — matches "* * * * *"

test("a due, enabled, readonly task runs and its lastRunIso/lastResult persist", async () => {
  upsertTask(task(), home);

  const deps: ScheduleRunnerDeps = {
    runOneShot: async () => okResult(),
    now: () => FIXED_NOW,
  };
  const { ran, skipped } = await runDueSchedules(home, deps);

  assert.equal(skipped, 0);
  assert.equal(ran.length, 1);
  assert.equal(ran[0]?.id, "t1");
  assert.equal(ran[0]?.lastRunIso, new Date(FIXED_NOW).toISOString());
  assert.deepEqual(ran[0]?.lastResult, {
    ok: true,
    summary: "done",
    ranIso: new Date(FIXED_NOW).toISOString(),
    toolCalls: ["read_file"],
  });

  // Reload from disk — the update must have been persisted, not just returned in-memory.
  const reloaded = loadSchedules(home);
  assert.deepEqual(reloaded.t1?.lastResult, ran[0]?.lastResult);
  assert.equal(reloaded.t1?.lastRunIso, ran[0]?.lastRunIso);
});

test("a disabled task and a not-yet-due task are both skipped and left untouched", async () => {
  const disabled = task({ id: "disabled", enabled: false });
  const notDue = task({ id: "not-due", cronExpr: "0 0 1 1 *" }); // Jan 1st only
  upsertTask(disabled, home);
  upsertTask(notDue, home);

  const deps: ScheduleRunnerDeps = {
    runOneShot: async () => {
      throw new Error("must not be called");
    },
    now: () => FIXED_NOW,
  };
  const { ran, skipped } = await runDueSchedules(home, deps);

  assert.equal(ran.length, 0);
  assert.equal(skipped, 2);

  const reloaded = loadSchedules(home);
  assert.deepEqual(reloaded.disabled, disabled);
  assert.deepEqual(reloaded["not-due"], notDue);
});

test("a throwing runOneShot still records a failed result and does not block a second due task", async () => {
  const first = task({ id: "throws", name: "throws" });
  const second = task({ id: "succeeds", name: "succeeds" });
  upsertTask(first, home);
  upsertTask(second, home);

  const deps: ScheduleRunnerDeps = {
    runOneShot: async (parsed) => {
      if (parsed.flags["session-id"]?.toString().startsWith("schedule-throws-")) {
        throw new Error("boom");
      }
      return okResult({ reply: "second task done" });
    },
    now: () => FIXED_NOW,
  };
  const { ran, skipped } = await runDueSchedules(home, deps);

  assert.equal(skipped, 0);
  assert.equal(ran.length, 2);

  const reloaded = loadSchedules(home);
  assert.equal(reloaded.throws?.lastResult?.ok, false);
  assert.match(reloaded.throws?.lastResult?.summary ?? "", /boom/);
  assert.ok(reloaded.throws?.lastRunIso, "the throwing task must still get a lastRunIso");

  assert.equal(reloaded.succeeds?.lastResult?.ok, true);
  assert.equal(reloaded.succeeds?.lastResult?.summary, "second task done");
});

test("autonomy maps onto the one-shot flag ladder exactly, per task, never more", async () => {
  const captured: Record<string, ParsedArgs> = {};
  const deps: ScheduleRunnerDeps = {
    runOneShot: async (parsed) => {
      const id = parsed.flags["session-id"]?.toString() ?? "";
      captured[id] = parsed;
      return okResult();
    },
    now: () => FIXED_NOW,
  };

  upsertTask(task({ id: "ro", autonomy: "readonly" }), home);
  upsertTask(task({ id: "ed", autonomy: "edits" }), home);
  upsertTask(task({ id: "cmd", autonomy: "commands" }), home);

  await runDueSchedules(home, deps);

  const bySessionPrefix = (prefix: string): ParsedArgs => {
    const entry = Object.entries(captured).find(([id]) => id.startsWith(prefix));
    assert.ok(entry, `expected a captured call for session prefix "${prefix}"`);
    return entry[1];
  };

  const ro = bySessionPrefix("schedule-ro-");
  assert.equal(ro.flags["allow-writes"], undefined);
  assert.equal(ro.flags["allow-commands"], undefined);

  const ed = bySessionPrefix("schedule-ed-");
  assert.equal(ed.flags["allow-writes"], true);
  assert.equal(ed.flags["allow-commands"], undefined);

  const cmd = bySessionPrefix("schedule-cmd-");
  assert.equal(cmd.flags["allow-commands"], true);
});

test("overlapping runDueSchedules invocations never execute the same due task concurrently or twice (whole-pass lock)", async () => {
  upsertTask(task(), home);

  let concurrent = 0;
  let maxConcurrent = 0;
  const deps: ScheduleRunnerDeps = {
    runOneShot: async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 150));
      concurrent--;
      return okResult();
    },
    now: () => FIXED_NOW,
  };

  // Fired via Promise.all, standing in for two overlapping `prometheus tasks run-due`
  // invocations (e.g. an installed cron tick firing again before the previous pass finished).
  const [a, b] = await Promise.all([runDueSchedules(home, deps), runDueSchedules(home, deps)]);

  assert.equal(maxConcurrent, 1, "the task must never run concurrently with itself");
  assert.equal(a.ran.length + b.ran.length, 1, "exactly one pass runs the task, not both");

  const reloaded = loadSchedules(home);
  assert.equal(reloaded.t1?.lastResult?.ok, true, "the task's own result was still recorded");
});

test("a run-due pass releases its lock even when a task throws, so the NEXT tick can still claim it", async () => {
  upsertTask(task(), home);
  const deps: ScheduleRunnerDeps = {
    runOneShot: async () => {
      throw new Error("boom");
    },
    now: () => FIXED_NOW,
  };

  const first = await runDueSchedules(home, deps);
  assert.equal(first.ran.length, 1);
  assert.equal(first.ran[0]?.lastResult?.ok, false);

  // A second, entirely separate pass afterward must NOT be told "already running" — the lock
  // from the first pass must have been released, not left behind.
  upsertTask(task({ cronExpr: "* * * * *" }), home); // still due at FIXED_NOW
  const second = await runDueSchedules(home, { ...deps, runOneShot: async () => okResult() });
  assert.equal(second.ran.length, 1);
  assert.notEqual(second.ran[0]?.lastResult?.ok, undefined);
});
