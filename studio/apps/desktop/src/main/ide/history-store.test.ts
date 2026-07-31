/**
 * history-store.test.ts — the MAIN-side Local History manager (APP-063). Real tmpdir fs,
 * injected clock (deterministic timestamps), immediate persist (debounce 0).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalHistoryManager, workspaceHash } from "./history-store.js";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-history-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A monotonic clock so each snapshot gets a distinct ts. */
function clock(): () => number {
  let t = 1000;
  return () => {
    t += 1000;
    return t;
  };
}

const ROOT = "/proj";
const A = "/proj/a.py";

test("capture → list: newest-first timeline with per-rev line deltas", async () => {
  await withTmp(async (dir) => {
    const m = new LocalHistoryManager({ dir, now: clock(), debounceMs: 0 });
    await m.bind(ROOT);
    m.capture(A, "one\ntwo\n");
    m.capture(A, "one\ntwo\nthree\n");
    const list = m.list(ROOT, A);
    assert.equal(list.length, 2);
    // newest first: the 2nd snapshot added a line vs the 1st.
    assert.equal(list[0]?.added, 1);
    assert.equal(list[0]?.removed, 0);
    assert.ok(list[0]!.ts > list[1]!.ts);
    // read a specific revision back.
    assert.equal(m.read(ROOT, A, list[1]!.ts), "one\ntwo\n");
  });
});

test("capture policy: a >maxBytes / never-capture path is skipped (no revision)", async () => {
  await withTmp(async (dir) => {
    const m = new LocalHistoryManager({ dir, now: clock(), debounceMs: 0 });
    await m.bind(ROOT);
    m.capture("/proj/.env", "SECRET=1\n"); // never-capture glob → skipped
    assert.deepEqual(m.list(ROOT, "/proj/.env"), []);
  });
});

test("persistence: flush → a fresh manager reloads the timeline (survives restart)", async () => {
  await withTmp(async (dir) => {
    const m1 = new LocalHistoryManager({ dir, now: clock(), debounceMs: 5000 });
    await m1.bind(ROOT);
    m1.capture(A, "v1\n");
    m1.capture(A, "v1\nv2\n");
    await m1.flush(); // write-behind → disk
    const m2 = new LocalHistoryManager({ dir });
    await m2.bind(ROOT); // reloads from the same dir
    const list = m2.list(ROOT, A);
    assert.equal(list.length, 2);
    assert.equal(m2.read(ROOT, A, list[0]!.ts), "v1\nv2\n");
  });
});

test("capture is a no-op until a workspace is bound; workspaceHash is stable per root", async () => {
  await withTmp(async (dir) => {
    const m = new LocalHistoryManager({ dir, now: clock(), debounceMs: 0 });
    m.capture(A, "x\n"); // nothing bound → dropped
    assert.deepEqual(m.list(ROOT, A), []);
  });
  assert.equal(workspaceHash("/proj"), workspaceHash("/proj"));
  assert.notEqual(workspaceHash("/proj/a"), workspaceHash("/proj/b"));
});
