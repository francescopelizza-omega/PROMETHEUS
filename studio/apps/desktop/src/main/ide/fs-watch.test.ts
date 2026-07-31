/**
 * fs-watch.test.ts — node:test for the fs read/write/tree + the debounced watcher.
 *
 * The fs read/write/tree run LIVE against a temp dir (node:fs is installed); the
 * watcher debounce/coalesce logic is driven by a FAKE watcher factory + injected
 * timers so it is deterministic (no flaky real fs-event timing). It pins:
 *   - fsTree: lazy one-level children, dirs-first, hasChildren flag,
 *   - fsRead/fsWrite round-trip + isLargeFile threshold,
 *   - the watcher coalesces a burst of raw events into ONE debounced `change` batch
 *     with the DISTINCT touched paths.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test fs-watch.test.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  type FsChangeEvent,
  FsWatchHost,
  type WatchHandle,
  type WatcherFactory,
  fsRead,
  fsTree,
  fsWalk,
  fsWrite,
  isLargeFile,
} from "./fs-watch.js";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "prom-fswatch-"));
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "src", "agents"));
  await writeFile(join(dir, "src", "agents", "runner.py"), "def run(): ...\n", "utf-8");
  await writeFile(join(dir, "README.md"), "# hi\n", "utf-8");
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/* ── fs read / write / tree (LIVE) ──────────────────────────────────────────*/

test("fsTree lists one level lazily, dirs-first, with hasChildren", async () => {
  const nodes = await fsTree(dir);
  // dirs first (src), then files (README.md).
  assert.equal(nodes[0]?.name, "src");
  assert.equal(nodes[0]?.kind, "dir");
  assert.equal(nodes[0]?.hasChildren, true);
  assert.ok(nodes.some((n) => n.name === "README.md" && n.kind === "file"));
  // it is LAZY — `src`'s children are NOT inlined here.
  assert.ok(!("children" in (nodes[0] ?? {})));
});

test("fsTree of a leaf dir returns only files", async () => {
  const nodes = await fsTree(join(dir, "src", "agents"));
  assert.deepEqual(
    nodes.map((n) => n.name),
    ["runner.py"],
  );
  assert.equal(nodes[0]?.kind, "file");
});

test("fsTree of a missing dir returns [] (never throws)", async () => {
  assert.deepEqual(await fsTree(join(dir, "does-not-exist")), []);
});

test("fsRead / fsWrite round-trip; isLargeFile is false for a small file", async () => {
  const p = join(dir, "scratch.txt");
  await fsWrite(p, "hello\nworld\n");
  const r = await fsRead(p);
  assert.equal(r.text, "hello\nworld\n");
  assert.equal(r.encoding, "utf-8");
  assert.equal(await isLargeFile(p), false);
});

/* ── the debounced watcher (fake factory + injected timers) ─────────────────*/

/** A fake timer surface (hand-advanced). */
class FakeTimers {
  private seq = 0;
  private clock = 0;
  readonly scheduled = new Map<number, { fn: () => void; due: number }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.scheduled.set(id, { fn, due: this.clock + ms });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.scheduled.delete(h as number);
  };
  advance(ms: number): void {
    this.clock += ms;
    for (const [id, t] of [...this.scheduled]) {
      if (t.due <= this.clock) {
        this.scheduled.delete(id);
        t.fn();
      }
    }
  }
}

/** A fake watcher factory the test drives by calling the captured onEvent. */
function fakeFactory(): {
  factory: WatcherFactory;
  fire(relPath: string): void;
  closed(): boolean;
} {
  let emit: ((p: string) => void) | null = null;
  let isClosed = false;
  const factory: WatcherFactory = (_root, onEvent) => {
    emit = onEvent;
    const handle: WatchHandle = {
      close: () => {
        isClosed = true;
      },
    };
    return handle;
  };
  return {
    factory,
    fire: (p) => emit?.(p),
    closed: () => isClosed,
  };
}

test("FsWatchHost coalesces a burst of raw events into ONE debounced change batch", () => {
  const timers = new FakeTimers();
  const fk = fakeFactory();
  const host = new FsWatchHost({ watcherFactory: fk.factory, debounceMs: 200, timers });
  const batches: FsChangeEvent[] = [];
  host.on("change", (e) => batches.push(e));

  host.watch("/proj");
  // a save touches several paths in quick succession (inside the debounce window).
  fk.fire("a.ts");
  fk.fire("b.ts");
  fk.fire("a.ts"); // duplicate → coalesced to a distinct set
  assert.equal(batches.length, 0, "no batch before the debounce window elapses");

  timers.advance(200);
  assert.equal(batches.length, 1, "exactly ONE coalesced batch");
  assert.equal(batches[0]?.root, "/proj");
  assert.deepEqual(batches[0]?.paths.sort(), ["/proj/a.ts", "/proj/b.ts"]);
  host.dispose();
});

test("FsWatchHost re-arms the debounce on each event (only the final quiet fires)", () => {
  const timers = new FakeTimers();
  const fk = fakeFactory();
  const host = new FsWatchHost({ watcherFactory: fk.factory, debounceMs: 200, timers });
  const batches: FsChangeEvent[] = [];
  host.on("change", (e) => batches.push(e));
  host.watch("/proj");

  fk.fire("a.ts");
  timers.advance(150); // not yet past the window…
  fk.fire("b.ts"); // …re-arms the timer
  timers.advance(150); // 150 since the LAST event → still not fired
  assert.equal(batches.length, 0);
  timers.advance(50); // now 200 since the last event → fires
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]?.paths.sort(), ["/proj/a.ts", "/proj/b.ts"]);
  host.dispose();
});

test("FsWatchHost.watch is idempotent; unwatch closes the underlying handle", () => {
  const timers = new FakeTimers();
  const fk = fakeFactory();
  const host = new FsWatchHost({ watcherFactory: fk.factory, debounceMs: 200, timers });
  host.watch("/proj");
  host.watch("/proj"); // no-op second watch
  assert.deepEqual(host.list(), ["/proj"]);
  host.unwatch("/proj");
  assert.equal(fk.closed(), true);
  assert.deepEqual(host.list(), []);
  host.dispose();
});

test("fsWalk: flat file list, prunes ignore dirs, skips binaries + a symlink loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "prom-fswalk-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "logo.png"), "binary");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = {}");
    // a symlink cycle that would hang a naive walk.
    const { symlink } = await import("node:fs/promises");
    await symlink(root, join(root, "src", "loop")).catch(() => {});
    const files = await fsWalk(root);
    const rel = files.map((f) => f.slice(root.length + 1)).sort();
    assert.ok(rel.includes(join("src", "a.ts")), "walked the real source file");
    assert.equal(
      rel.some((f) => f.includes("node_modules")),
      false,
      "pruned node_modules",
    );
    assert.equal(
      rel.some((f) => f.endsWith(".png")),
      false,
      "skipped the binary",
    );
    assert.equal(
      rel.some((f) => f.includes("loop")),
      false,
      "did not follow the symlink loop",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
