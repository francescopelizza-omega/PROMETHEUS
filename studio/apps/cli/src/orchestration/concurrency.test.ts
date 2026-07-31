/**
 * concurrency.test.ts — the per-provider semaphore bulkhead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { KeyedSemaphore, Semaphore, defaultProviderLimit } from "./concurrency.js";

/** A controllable async task that reports peak concurrency. */
function tracker() {
  let active = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    task: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    },
  };
}

test("Semaphore caps concurrency at the limit", async () => {
  const t = tracker();
  const sem = new Semaphore(2);
  await Promise.all(Array.from({ length: 8 }, () => sem.run(t.task)));
  assert.ok(t.peak <= 2, `peak concurrency ${t.peak} must be ≤ 2`);
});

test("Semaphore with limit 1 fully serializes", async () => {
  const t = tracker();
  const sem = new Semaphore(1);
  await Promise.all(Array.from({ length: 5 }, () => sem.run(t.task)));
  assert.equal(t.peak, 1);
});

test("Semaphore releases the slot even when a task throws", async () => {
  const sem = new Semaphore(1);
  await assert.rejects(
    sem.run(async () => {
      throw new Error("boom");
    }),
  );
  // the slot was released → a subsequent task runs
  let ran = false;
  await sem.run(async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("KeyedSemaphore isolates per-key limits", async () => {
  const a = tracker();
  const b = tracker();
  const ks = new KeyedSemaphore(() => 1); // each key serialized independently
  await Promise.all([
    ...Array.from({ length: 3 }, () => ks.run("claude", a.task)),
    ...Array.from({ length: 3 }, () => ks.run("gemini", b.task)),
  ]);
  // each key is serialized (peak 1), but the two keys ran in parallel
  assert.equal(a.peak, 1);
  assert.equal(b.peak, 1);
});

test("defaultProviderLimit gives independent per-vendor caps", () => {
  assert.equal(defaultProviderLimit("claude"), 3);
  assert.equal(defaultProviderLimit("codex"), 4);
  assert.equal(defaultProviderLimit("gemini"), 5);
  assert.equal(defaultProviderLimit("cursor"), 2);
  assert.equal(defaultProviderLimit("unknown"), 3);
});
