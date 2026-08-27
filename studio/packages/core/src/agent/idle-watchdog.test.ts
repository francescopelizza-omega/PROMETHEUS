/**
 * idle-watchdog.test.ts — the inactivity-pause primitive: activity tracking, ticking, the
 * orphaned-generation guard.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_ORPHAN_GRACE_MS,
  IdleWatchdog,
  MAX_IDLE_TIMEOUT_MS,
  MIN_IDLE_TIMEOUT_MS,
  clampIdleTimeoutMs,
  clearPossibleOrphan,
  markPossibleOrphan,
  orphanGraceRemainingMs,
  raceTicks,
} from "./idle-watchdog.js";

/**
 * A fake clock + fake timers, INJECTED (never a global monkeypatch) — `IdleWatchdog` accepts
 * `now`/`setTimeoutFn`/`clearTimeoutFn` exactly so tests can drive a 10-minute default deadline
 * instantly and deterministically, rather than waiting out real wall-clock time.
 */
function fakeClock() {
  let t = 0;
  const timers: { at: number; cb: () => void; id: number }[] = [];
  let nextId = 1;
  return {
    now: () => t,
    setTimeoutFn: (cb: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: t + ms, cb, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (id: unknown) => {
      const idx = timers.findIndex((x) => x.id === id);
      if (idx !== -1) timers.splice(idx, 1);
    },
    advance: (ms: number) => {
      t += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= t) {
          const idx = timers.indexOf(timer);
          if (idx !== -1) timers.splice(idx, 1);
          timer.cb();
        }
      }
    },
  };
}

// Below MIN_IDLE_TIMEOUT_MS (30s), clampIdleTimeoutMs silently bumps the threshold up to the
// floor — so every timing test here uses a value ABOVE the floor, or its assertions would
// actually be exercising 30s regardless of what was requested.
const TEST_IDLE_MS = 40_000;

test("IdleWatchdog: onIdle fires exactly once after the idle window elapses with no touch()", () => {
  const clock = fakeClock();
  let fired = 0;
  const wd = new IdleWatchdog({
    idleTimeoutMs: TEST_IDLE_MS,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onIdle: () => fired++,
  });
  wd.arm();
  clock.advance(TEST_IDLE_MS - 1);
  assert.equal(fired, 0);
  assert.equal(wd.didFire(), false);
  clock.advance(2);
  assert.equal(fired, 1);
  assert.equal(wd.didFire(), true);
  clock.advance(10 * TEST_IDLE_MS); // must not fire again
  assert.equal(fired, 1);
});

test("IdleWatchdog.touch() resets the countdown — activity, not just extension, prevents firing", () => {
  const clock = fakeClock();
  let fired = 0;
  const wd = new IdleWatchdog({
    idleTimeoutMs: TEST_IDLE_MS,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onIdle: () => fired++,
  });
  wd.arm();
  clock.advance(TEST_IDLE_MS - 1000);
  wd.touch();
  // (TEST_IDLE_MS - 1000) + (TEST_IDLE_MS - 1000) > TEST_IDLE_MS, but touch() reset the clock.
  clock.advance(TEST_IDLE_MS - 1000);
  assert.equal(fired, 0, "touch() should have reset the idle countdown");
  clock.advance(1200); // now (TEST_IDLE_MS + 200)ms since the touch — should fire
  assert.equal(fired, 1);
});

test("IdleWatchdog.dispose() before the deadline prevents onIdle from EVER firing", () => {
  const clock = fakeClock();
  let fired = 0;
  const wd = new IdleWatchdog({
    idleTimeoutMs: TEST_IDLE_MS,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onIdle: () => fired++,
  });
  wd.arm();
  clock.advance(TEST_IDLE_MS / 2);
  wd.dispose();
  clock.advance(10 * TEST_IDLE_MS);
  assert.equal(fired, 0);
});

test("IdleWatchdog.idleForMs() reports time since the LAST touch, not since construction", () => {
  const clock = fakeClock();
  const wd = new IdleWatchdog({
    idleTimeoutMs: 10_000,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onIdle: () => {},
  });
  wd.arm();
  clock.advance(3000);
  wd.touch();
  clock.advance(1200);
  assert.equal(wd.idleForMs(), 1200);
});

test("IdleWatchdog: a real long-but-active run (spaced closer than the idle window) never fires", () => {
  // The core "activity, not total time" property: 20 touches spaced 900ms apart under a 1000ms
  // idle window span 18 SECONDS of wall-clock time — far longer than the window itself — and
  // must never trip, because the gap between any two touches never exceeds the window.
  const clock = fakeClock();
  let fired = 0;
  const wd = new IdleWatchdog({
    idleTimeoutMs: TEST_IDLE_MS,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    onIdle: () => fired++,
  });
  wd.arm();
  // 20 touches spaced at (TEST_IDLE_MS - 1000) apart — always UNDER the idle window, but their
  // SUM (well over 700_000ms here) is far past the window's own size, proving this is bounded
  // by the gap between touches, not by total elapsed time.
  for (let i = 0; i < 20; i++) {
    clock.advance(TEST_IDLE_MS - 1000);
    wd.touch();
  }
  assert.equal(fired, 0);
});

test("clampIdleTimeoutMs: undefined/non-finite → default; out-of-range values are clamped", () => {
  assert.equal(clampIdleTimeoutMs(undefined), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(clampIdleTimeoutMs(Number.NaN), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(clampIdleTimeoutMs(1), MIN_IDLE_TIMEOUT_MS);
  assert.equal(clampIdleTimeoutMs(MAX_IDLE_TIMEOUT_MS * 10), MAX_IDLE_TIMEOUT_MS);
  assert.equal(clampIdleTimeoutMs(60_000), 60_000);
});

test("raceTicks: yields several ticks before resolving, using real short timers", async () => {
  let resolvePending: (v: string) => void = () => {};
  const pending = new Promise<string>((r) => {
    resolvePending = r;
  });
  const ticker = raceTicks(pending, 5, () => "tick");
  setTimeout(() => resolvePending("done"), 30);
  const notes: string[] = [];
  let step = await ticker.next();
  while (!step.done) {
    notes.push(step.value);
    step = await ticker.next();
  }
  assert.equal(step.value, "done");
  assert.ok(notes.length >= 2, `expected several ticks before resolution, got ${notes.length}`);
  assert.ok(notes.every((n) => n === "tick"));
});

test("raceTicks: propagates a rejection from `pending`, with no tick after it", async () => {
  const pending = Promise.reject(new Error("boom"));
  const ticker = raceTicks(pending, 50, () => "tick");
  await assert.rejects(() => ticker.next(), /boom/);
});

test("raceTicks: a rejection does NOT leak the tick timer (regression: the primary — idle-pause — path)", async () => {
  // `pending` rejects almost immediately, well before the (deliberately long) tick would ever
  // fire — exactly what happens when the idle watchdog aborts the fetch/read this races. Spy
  // on the real `clearTimeout` (raceTicks has no clock-injection seam of its own) to prove the
  // tick timer was actually cleared on the REJECTION path, not just that the rejection itself
  // propagated — a prior version of this test only checked the latter and missed a real leak.
  const realClearTimeout = globalThis.clearTimeout;
  const cleared: unknown[] = [];
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    cleared.push(id);
    return realClearTimeout(id);
  }) as typeof clearTimeout;
  try {
    const pending = Promise.reject(new Error("boom"));
    const ticker = raceTicks(pending, 60_000, () => "tick");
    await assert.rejects(() => ticker.next(), /boom/);
    assert.equal(cleared.length, 1, "the tick timer must be cleared even when `pending` rejects");
  } finally {
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("raceTicks: resolving before the first tick yields no ticks at all", async () => {
  const pending = Promise.resolve("instant");
  const ticker = raceTicks(pending, 50, () => "tick");
  const step = await ticker.next();
  assert.equal(step.done, true);
  assert.equal(step.value, "instant");
});

test("orphan guard: mark → remaining > 0 and ≤ the grace period; a second read after expiry is 0", () => {
  const clock = fakeClock();
  markPossibleOrphan("ep-1", clock.now);
  const remaining = orphanGraceRemainingMs("ep-1", DEFAULT_ORPHAN_GRACE_MS, clock.now);
  assert.ok(remaining > 0 && remaining <= DEFAULT_ORPHAN_GRACE_MS);
  clock.advance(DEFAULT_ORPHAN_GRACE_MS + 1);
  assert.equal(orphanGraceRemainingMs("ep-1", DEFAULT_ORPHAN_GRACE_MS, clock.now), 0);
  // the entry was cleared on expiry, not just reported as expired — a second read agrees.
  assert.equal(orphanGraceRemainingMs("ep-1", DEFAULT_ORPHAN_GRACE_MS, clock.now), 0);
});

test("orphan guard: clearPossibleOrphan zeroes it immediately, before the grace period elapses", () => {
  const clock = fakeClock();
  markPossibleOrphan("ep-2", clock.now);
  assert.ok(orphanGraceRemainingMs("ep-2", DEFAULT_ORPHAN_GRACE_MS, clock.now) > 0);
  clearPossibleOrphan("ep-2");
  assert.equal(orphanGraceRemainingMs("ep-2", DEFAULT_ORPHAN_GRACE_MS, clock.now), 0);
});

test("orphan guard: an untracked endpoint reports 0, never throws", () => {
  assert.equal(orphanGraceRemainingMs("never-seen-endpoint"), 0);
});
