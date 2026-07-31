/**
 * worker-task-seam.test.ts — node:test for the offload seam (APP-066).
 *
 * Pins the two behaviours the seam adds over a bare dispatcher, with a FAKE
 * dispatcher (no Electron / utilityProcess):
 *   - GRACEFUL FALLBACK: when the worker `run` rejects (spawn error / crash / timeout)
 *     the SAME task runs INLINE and returns a CORRECT result; the one-time `onFallback`
 *     hook fires exactly once across repeated failures.
 *   - CANCEL correlation: `handle.cancel()` reaches the dispatcher with the task's id.
 *   - PASSTHROUGH: a healthy worker result is returned verbatim (no inline run).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { runTask } from "../worker/tasks.js";
import type { TaskRequest, TaskResponse } from "../worker/tasks.js";
import { type WorkerTaskDispatcher, makeWorkerTaskSeam } from "./worker-task-seam.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "prom-seam-"));
  await writeFile(join(dir, "a.ts"), "export const foo = 1;\n");
  await writeFile(join(dir, "b.ts"), "export const bar = 2;\n");
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A dispatcher whose `run` always rejects (a dead/crashing worker). */
class RejectingDispatcher implements WorkerTaskDispatcher {
  cancels: string[] = [];
  run(): Promise<TaskResponse> {
    return Promise.reject(new Error("worker exited (code 1) with a request in flight"));
  }
  cancel(id: string): void {
    this.cancels.push(id);
  }
}

test("seam falls back INLINE with a correct result when the worker rejects (APP-066)", async () => {
  const disp = new RejectingDispatcher();
  let fallbacks = 0;
  const run = makeWorkerTaskSeam(disp, runTask, () => {
    fallbacks += 1;
  });
  const h1 = run({ kind: "file.search", payload: { root: dir, extensions: ["ts"] } });
  const res = await h1.result;
  assert.equal(res.ok, true);
  assert.equal(res.kind, "file.search");
  // the inline walk returned the SAME result the worker would have.
  const inline = runTask({
    id: "x",
    kind: "file.search",
    payload: { root: dir, extensions: ["ts"] },
  });
  assert.equal(res.ok && res.kind === "file.search" ? res.result.matches.length : -1, 2);
  assert.deepEqual(
    res.ok && res.kind === "file.search" ? res.result.matches.map((m) => m.rel) : [],
    inline.ok && inline.kind === "file.search" ? inline.result.matches.map((m) => m.rel) : [],
  );
  // a SECOND failure does not re-log — onFallback fires only once.
  await run({ kind: "file.search", payload: { root: dir } }).result;
  assert.equal(fallbacks, 1, "fallback announced once, not per task");
});

/** A healthy dispatcher that echoes a canned ok result and records cancels. */
class HealthyDispatcher implements WorkerTaskDispatcher {
  lastId: string | undefined;
  cancels: string[] = [];
  run(
    req: Omit<TaskRequest, "id">,
    opts?: { id?: string; onProgress?: (p: { scanned: number }) => void },
  ): Promise<TaskResponse> {
    this.lastId = opts?.id;
    opts?.onProgress?.({ scanned: 42 });
    return Promise.resolve({
      id: opts?.id ?? "0",
      kind: "file.search",
      ok: true,
      result: { root: "/r", matches: [], scanned: 42, truncated: false },
    });
  }
  cancel(id: string): void {
    this.cancels.push(id);
  }
}

test("seam passes a healthy worker result through and forwards progress (no inline run)", async () => {
  const disp = new HealthyDispatcher();
  let fallbacks = 0;
  const seen: number[] = [];
  const run = makeWorkerTaskSeam(disp, runTask, () => {
    fallbacks += 1;
  });
  const h = run(
    { kind: "file.search", payload: { root: "/r" } },
    { onProgress: (n) => seen.push(n) },
  );
  const res = await h.result;
  assert.equal(res.ok, true);
  assert.equal(fallbacks, 0, "healthy worker never falls back");
  assert.deepEqual(seen, [42], "progress {scanned} adapted to a bare number");
});

test("seam.cancel reaches the dispatcher with the task's id (APP-066)", async () => {
  const disp = new HealthyDispatcher();
  const run = makeWorkerTaskSeam(disp, runTask);
  const h = run({ kind: "file.search", payload: { root: "/r" } });
  await h.result;
  h.cancel();
  assert.equal(disp.cancels.length, 1);
  assert.equal(disp.cancels[0], disp.lastId); // the SAME correlated id
  assert.equal(disp.cancels[0], h.id);
});
