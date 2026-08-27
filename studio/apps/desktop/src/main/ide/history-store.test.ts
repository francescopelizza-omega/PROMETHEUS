/**
 * history-store.test.ts — the MAIN-side Local History manager (APP-063). Real tmpdir fs,
 * injected clock (deterministic timestamps), immediate persist (debounce 0).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalHistoryManager, workspaceHash } from "./history-store.js";

/**
 * A tmpdir that is removed only once every manager built inside it has stopped writing.
 *
 * The manager persists write-behind, so even `debounceMs: 0` defers the write past the end of a
 * synchronous test body: removing the directory right after `fn` resolved raced a temp+rename
 * still in flight and failed the test with ENOTEMPTY, roughly one run in five. Handing the body
 * a `track` callback keeps the teardown honest — the fix is to WAIT for the writer, not to
 * retry the removal until the loser gives up.
 */
async function withTmp(
  fn: (dir: string, track: (m: LocalHistoryManager) => LocalHistoryManager) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-history-"));
  const live: LocalHistoryManager[] = [];
  const track = (m: LocalHistoryManager): LocalHistoryManager => {
    live.push(m);
    return m;
  };
  try {
    await fn(dir, track);
  } finally {
    for (const m of live) await m.flush();
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
  await withTmp(async (dir, track) => {
    const m = track(new LocalHistoryManager({ dir, now: clock(), debounceMs: 0 }));
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
  await withTmp(async (dir, track) => {
    const m = track(new LocalHistoryManager({ dir, now: clock(), debounceMs: 0 }));
    await m.bind(ROOT);
    m.capture("/proj/.env", "SECRET=1\n"); // never-capture glob → skipped
    assert.deepEqual(m.list(ROOT, "/proj/.env"), []);
  });
});

test("persistence: flush → a fresh manager reloads the timeline (survives restart)", async () => {
  await withTmp(async (dir, track) => {
    const m1 = track(new LocalHistoryManager({ dir, now: clock(), debounceMs: 5000 }));
    await m1.bind(ROOT);
    m1.capture(A, "v1\n");
    m1.capture(A, "v1\nv2\n");
    await m1.flush(); // write-behind → disk
    const m2 = track(new LocalHistoryManager({ dir }));
    await m2.bind(ROOT); // reloads from the same dir
    const list = m2.list(ROOT, A);
    assert.equal(list.length, 2);
    assert.equal(m2.read(ROOT, A, list[0]!.ts), "v1\nv2\n");
  });
});

test("capture is a no-op until a workspace is bound; workspaceHash is stable per root", async () => {
  await withTmp(async (dir, track) => {
    const m = track(new LocalHistoryManager({ dir, now: clock(), debounceMs: 0 }));
    m.capture(A, "x\n"); // nothing bound → dropped
    assert.deepEqual(m.list(ROOT, A), []);
  });
  assert.equal(workspaceHash("/proj"), workspaceHash("/proj"));
  assert.notEqual(workspaceHash("/proj/a"), workspaceHash("/proj/b"));
});

test("flush() waits for a write that is ALREADY in flight, not just for pending timers", async () => {
  /**
   * The quit path: `flush()` is what makes "no revision is lost on quit" true. It used to
   * collect only roots with a PENDING debounce timer — but once a timer fires it removes itself
   * from that map and the write it starts was `void`-ed, so a flush landing in that window saw
   * an empty set and resolved with temp files still being written and renamed behind it.
   *
   * Several roots are used because one is a coin flip: the pre-fix `flush()` had to lose the
   * race on every single root to leave the assertion below satisfied.
   */
  await withTmp(async (dir, track) => {
    const m = track(new LocalHistoryManager({ dir, now: clock(), debounceMs: 0 }));
    const roots = Array.from({ length: 8 }, (_, i) => `/proj${i}`);
    for (const root of roots) {
      await m.bind(root);
      m.capture(`${root}/a.py`, "one\n");
    }
    // let every debounce timer FIRE, so each root's write is in flight rather than pending.
    await new Promise((r) => setTimeout(r, 0));
    await m.flush();
    for (const root of roots) {
      assert.ok(
        existsSync(join(dir, `${workspaceHash(root)}.json`)),
        `flush() returned before ${root}'s write landed`,
      );
    }
  });
});
