/**
 * resource-guard.test.ts — ACTIVE EVICTION for tracked opencode/hermes subprocesses. Every
 * primitive is injected (no real spawn, no real signal, no real eviction-log write) — the
 * `checkOrchestrationResourcePressure` unit takes its own `streakRef` so a test can drive many
 * "ticks" without a real 30s interval.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { EvictionEvent } from "@prometheus/engine-bridge";

import { checkOrchestrationResourcePressure, type ResourceGuardDeps } from "./resource-guard.js";

interface FakeChild {
  pid: number;
  group: boolean;
  label: string;
}

function makeDeps(
  children: FakeChild[],
  overrides: Partial<ResourceGuardDeps> = {},
): { deps: ResourceGuardDeps; signals: Array<[number, string]>; events: EvictionEvent[] } {
  const signals: Array<[number, string]> = [];
  const events: EvictionEvent[] = [];
  const deps: ResourceGuardDeps = {
    trackedChildrenFn: () => children,
    signalTrackedFn: (pid, signal) => {
      signals.push([pid, signal]);
      return true;
    },
    recordEvictionFn: (event) => {
      const full: EvictionEvent = { ...event, id: `evt-${events.length + 1}`, at: "2026-01-01T00:00:00.000Z" };
      events.push(full);
      return full;
    },
    pidAliveFn: () => true,
    sleepFn: async () => {},
    ramSampleFn: () => 10,
    ...overrides,
  };
  return { deps, signals, events };
}

test("nothing tracked → RAM is never even sampled, streak resets, nothing signalled", async () => {
  let sampled = false;
  const { deps, signals } = makeDeps([], { ramSampleFn: () => (sampled = true) && 99 });
  const streak = { value: 3 }; // a stale streak from before the last child exited
  await checkOrchestrationResourcePressure(streak, deps);
  assert.equal(sampled, false, "a session that never touches /demos must pay nothing for this");
  assert.deepEqual(signals, []);
  assert.equal(streak.value, 0, "an old streak must not carry over once nothing is left to protect");
});

test("only UNGUARDED tracked children (e.g. agent:claude) are ignored entirely", async () => {
  const { deps, signals } = makeDeps(
    [{ pid: 111, group: true, label: "agent:claude" }],
    { ramSampleFn: () => 99 },
  );
  const streak = { value: 0 };
  await checkOrchestrationResourcePressure(streak, deps);
  await checkOrchestrationResourcePressure(streak, deps);
  assert.deepEqual(signals, [], "claude/codex/etc. are the pre-spawn ceiling's job, not this one's");
});

test("a single critical reading never evicts — sustained pressure is required", async () => {
  const { deps, signals } = makeDeps(
    [{ pid: 222, group: true, label: "agent:opencode" }],
    { ramSampleFn: () => 97 },
  );
  const streak = { value: 0 };
  await checkOrchestrationResourcePressure(streak, deps);
  assert.deepEqual(signals, []);
  assert.equal(streak.value, 1);
});

test("SUSTAINED critical RAM (2 consecutive ticks) evicts every guarded child: SIGTERM then SIGKILL if still alive", async () => {
  const { deps, signals, events } = makeDeps(
    [
      { pid: 222, group: true, label: "agent:opencode" },
      { pid: 333, group: true, label: "agent:hermes" },
    ],
    { ramSampleFn: () => 97, pidAliveFn: () => true },
  );
  const streak = { value: 0 };
  await checkOrchestrationResourcePressure(streak, deps); // 1st critical tick — not enough alone
  assert.deepEqual(signals, []);
  await checkOrchestrationResourcePressure(streak, deps); // 2nd — sustained → evict

  assert.deepEqual(
    signals,
    [
      [222, "SIGTERM"],
      [333, "SIGTERM"],
      [222, "SIGKILL"],
      [333, "SIGKILL"],
    ],
    "both guarded children get the SIGTERM→grace→SIGKILL escalation, in tracked order",
  );
  assert.equal(events.length, 2, "one eviction notice per killed child");
  assert.deepEqual(
    events.map((e) => e.runnerId).sort(),
    ["hermes", "opencode"],
  );
  assert.match(events[0]?.reason ?? "", /RAM at 97%/);
  assert.equal(streak.value, 0, "the streak resets after acting, win or lose");
});

test("if a child exits cleanly after SIGTERM (no longer alive), it is NOT also SIGKILLed", async () => {
  const { deps, signals } = makeDeps(
    [{ pid: 222, group: true, label: "agent:opencode" }],
    { ramSampleFn: () => 97, pidAliveFn: () => false },
  );
  const streak = { value: 1 }; // already one critical tick in
  await checkOrchestrationResourcePressure(streak, deps); // 2nd → sustained → evict
  assert.deepEqual(signals, [[222, "SIGTERM"]], "exited cleanly ⇒ no SIGKILL follow-up");
});

test("an interrupted streak (one clear reading) resets progress entirely, never accumulates across a recovery", async () => {
  const { deps, signals } = makeDeps(
    [{ pid: 222, group: true, label: "agent:opencode" }],
    { ramSampleFn: () => 97 },
  );
  const streak = { value: 0 };
  await checkOrchestrationResourcePressure(streak, deps); // critical: streak → 1
  assert.equal(streak.value, 1);
  deps.ramSampleFn = () => 20; // machine recovers
  await checkOrchestrationResourcePressure(streak, deps);
  assert.equal(streak.value, 0);
  deps.ramSampleFn = () => 97;
  await checkOrchestrationResourcePressure(streak, deps); // back to critical: 1 again, not 2
  assert.equal(streak.value, 1);
  assert.deepEqual(signals, [], "never reached sustained — must never have evicted anything");
});
