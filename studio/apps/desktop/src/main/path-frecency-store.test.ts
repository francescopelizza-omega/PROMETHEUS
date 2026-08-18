/**
 * path-frecency-store.test.ts — the per-workspace frecency file (real tmpdir fs, no Electron).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadPathFrecency,
  pathFrecencyPath,
  recordPathUse,
  savePathFrecency,
} from "./path-frecency-store.js";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-path-frecency-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("pathFrecencyPath: a sibling of the workspace settings layer under .prometheus/", () => {
  assert.equal(pathFrecencyPath("/repo"), join("/repo", ".prometheus", "path-frecency.json"));
});

test("loadPathFrecency: a missing store file yields an empty store (fail-soft)", async () => {
  await withTmpDir(async (dir) => {
    assert.deepEqual(await loadPathFrecency(dir), { entries: [] });
  });
});

test("savePathFrecency then loadPathFrecency round-trips", async () => {
  await withTmpDir(async (dir) => {
    const store = { entries: [{ path: join(dir, "src/a.ts"), count: 3, lastUsedMs: 1000 }] };
    await savePathFrecency(dir, store);
    assert.deepEqual(await loadPathFrecency(dir), store);
  });
});

test("recordPathUse persists an incrementing, round-trippable store", async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, "a.ts");
    await recordPathUse(dir, file, 1000);
    const after = await recordPathUse(dir, file, 2000);
    assert.deepEqual(after.entries, [{ path: file, count: 2, lastUsedMs: 2000 }]);
    assert.deepEqual(await loadPathFrecency(dir), after);
  });
});

test("two different workspace roots get two independent stores", async () => {
  await withTmpDir(async (dirA) => {
    await withTmpDir(async (dirB) => {
      await recordPathUse(dirA, join(dirA, "x.ts"), 1000);
      await recordPathUse(dirB, join(dirB, "y.ts"), 1000);
      assert.deepEqual((await loadPathFrecency(dirA)).entries, [
        { path: join(dirA, "x.ts"), count: 1, lastUsedMs: 1000 },
      ]);
      assert.deepEqual((await loadPathFrecency(dirB)).entries, [
        { path: join(dirB, "y.ts"), count: 1, lastUsedMs: 1000 },
      ]);
    });
  });
});
