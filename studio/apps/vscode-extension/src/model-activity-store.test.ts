/**
 * model-activity-store.test.ts — this extension's write-only half of the shared activity file
 * (see the module's own docstring: "deliberately simpler" — no read/path-getter exported here,
 * only the CLI sibling needs those). Same `withHome` PROMETHEUS_HOME-override pattern as
 * apps/desktop/src/main/model-activity-store.test.ts and model-health-store-path.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { touchModelActivity } from "./model-activity-store.js";

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

/** The path this module (and its CLI/desktop siblings) all share. */
function activityPath(home: string): string {
  return join(home, "state", "model-activity.json");
}

test("touchModelActivity writes the SAME shared path the CLI/desktop siblings use", async () => {
  await withHome((home) => {
    touchModelActivity();
    const raw = JSON.parse(readFileSync(activityPath(home), "utf8"));
    assert.equal(typeof raw.lastActiveAt, "number");
  });
});

test("touchModelActivity records a fresh, current timestamp", async () => {
  await withHome((home) => {
    const before = Date.now();
    touchModelActivity();
    const after = Date.now();
    const raw = JSON.parse(readFileSync(activityPath(home), "utf8"));
    assert.ok(raw.lastActiveAt >= before && raw.lastActiveAt <= after);
  });
});

test("touchModelActivity creates the state directory on a completely fresh home", async () => {
  await withHome(() => {
    assert.doesNotThrow(() => touchModelActivity());
  });
});

test("touchModelActivity never throws even if called twice in a row", async () => {
  await withHome(() => {
    touchModelActivity();
    assert.doesNotThrow(() => touchModelActivity());
  });
});
