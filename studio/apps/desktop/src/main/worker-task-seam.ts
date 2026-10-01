// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/worker-task-seam.ts — the OFFLOAD seam (APP-066).
 *
 * Wraps a worker dispatcher (the Electron-backed WorkerHost in prod) into the
 * `RunWorkerTask` shape ide-ipc consumes, adding the two behaviours the plan
 * requires around a bare `host.run`:
 *   - CANCEL correlation: every task gets a stable id so a caller can `cancel(id)`
 *     the specific in-flight task (the renderer passes a search's requestId through);
 *   - GRACEFUL FALLBACK: on ANY worker failure (spawn error, crash mid-task, timeout)
 *     the SAME task runs INLINE via `runInline` so the IPC call still returns a correct
 *     result — a dead worker must never fail the feature. The fallback is announced ONCE
 *     (not per task) so a persistently-broken worker can't spam the log.
 *
 * Kept OUT of index.ts (which imports electron) so the fallback path is node:test-covered
 * with a fake dispatcher — no utilityProcess required.
 */

import type { TaskRequest, TaskResponse } from "../worker/tasks.js";
import type { RunWorkerTask } from "./ide-ipc.js";

/** The minimal host surface the seam needs; the real WorkerHost satisfies it structurally. */
export interface WorkerTaskDispatcher {
  run(
    req: Omit<TaskRequest, "id">,
    opts?: { id?: string; onProgress?: (progress: { scanned: number }) => void },
  ): Promise<TaskResponse>;
  cancel(id: string): void;
}

/** The inline dispatcher (the pure `runTask` from worker/tasks.ts) used on fallback. */
export type InlineRunner = (
  req: TaskRequest,
  hooks?: { onProgress?: (scanned: number) => void },
) => TaskResponse;

/**
 * Build the offload seam. `host` runs tasks in the worker; on rejection the SAME task
 * runs through `runInline`. `onFallback` (optional) is invoked the FIRST time a fallback
 * happens (for a one-time log line).
 */
export function makeWorkerTaskSeam(
  host: WorkerTaskDispatcher,
  runInline: InlineRunner,
  onFallback?: (kind: string, error: string) => void,
): RunWorkerTask {
  let seq = 0;
  let warned = false;
  return (req, opts) => {
    const id = `wt${++seq}`;
    const runOpts: { id: string; onProgress?: (progress: { scanned: number }) => void } = { id };
    if (opts?.onProgress) {
      const cb = opts.onProgress;
      runOpts.onProgress = (p) => cb(p.scanned); // adapt {scanned} → scanned
    }
    const result = host.run(req, runOpts).catch((err: unknown): TaskResponse => {
      if (!warned) {
        warned = true;
        onFallback?.(req.kind, err instanceof Error ? err.message : String(err));
      }
      return runInline(
        { ...req, id } as TaskRequest,
        opts?.onProgress ? { onProgress: opts.onProgress } : undefined,
      );
    });
    return { id, result, cancel: () => host.cancel(id) };
  };
}
