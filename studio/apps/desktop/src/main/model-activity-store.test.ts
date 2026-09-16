/**
 * model-activity-store.test.ts — mirrors model-health-store-path.test.ts's `withHome` pattern:
 * this module reads `prometheusHome()` internally (no injected fs/home param — see its own
 * docstring for why it's "deliberately simpler" than the CLI's fully-injectable sibling), so
 * PROMETHEUS_HOME is pointed at a temp dir for the duration of each test instead.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readModelActivity, sharedModelActivityPath, touchModelActivity } from "./model-activity-store.js";

/** Point `prometheusHome()` at a temp dir for the duration of `fn` — awaited so an async `fn`'s
 *  body finishes BEFORE the temp dir is torn down and the env var restored. */
async function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "prom-home-"));
  const prev = process.env.PROMETHEUS_HOME;
  process.env.PROMETHEUS_HOME = home;
  try {
    return await fn(home);
  } finally {
    // biome-ignore lint/performance/noDelete: restoring ABSENCE, which assignment cannot do
    if (prev === undefined) delete process.env.PROMETHEUS_HOME;
    else process.env.PROMETHEUS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("sharedModelActivityPath: the exact path the CLI's model-activity-store.ts also writes", async () => {
  await withHome((home) => {
    assert.equal(sharedModelActivityPath(), join(home, "state", "model-activity.json"));
  });
});

test("readModelActivity: no file yet → lastActiveAt:0, never throws", async () => {
  await withHome(() => {
    assert.deepEqual(readModelActivity(), { lastActiveAt: 0 });
  });
});

test("touchModelActivity then readModelActivity round-trips a real timestamp", async () => {
  await withHome(() => {
    const before = Date.now();
    touchModelActivity();
    const after = Date.now();
    const { lastActiveAt } = readModelActivity();
    assert.ok(lastActiveAt >= before && lastActiveAt <= after);
  });
});

test("touchModelActivity creates the state directory on a completely fresh home", async () => {
  await withHome(() => {
    assert.doesNotThrow(() => touchModelActivity());
    assert.doesNotThrow(() => readModelActivity());
  });
});

test("a second touchModelActivity call overwrites the first, never merges/appends", async () => {
  await withHome(async () => {
    touchModelActivity();
    const first = readModelActivity().lastActiveAt;
    await new Promise((resolve) => setTimeout(resolve, 2)); // force a strictly later timestamp
    touchModelActivity();
    const second = readModelActivity().lastActiveAt;
    assert.ok(second > first);
  });
});
