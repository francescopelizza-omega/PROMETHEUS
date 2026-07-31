/**
 * worker/index.ts — the WORKER process ENTRYPOINT (file 01 §5).
 *
 * This is the only file in the worker layer that touches the message transport.
 * In production it is launched as an Electron `utilityProcess` from the MAIN
 * process; under node:test it is launched as a plain `child_process.fork`. BOTH
 * expose a `process`-level message channel, so this entry binds to whichever is
 * present and then defers ALL work to the pure functions in worker/tasks.ts.
 *
 * It deliberately imports NOTHING from electron: a utilityProcess child receives
 * and sends messages over `process.parentPort` (Electron) OR `process.send` /
 * `process.on("message")` (Node fork). We feature-detect and wire the right one.
 * This keeps the entry runnable under node:test (the host forks it) AND correct
 * as a real Electron utilityProcess.
 *
 * Per the brief, the entry is a THIN transport: parse → runTask → post. The
 * heavy, deterministic logic lives in tasks.ts and is unit-tested directly.
 */

import {
  type TaskProgress,
  type TaskResponse,
  isCancelMessage,
  isTaskRequest,
  runTask,
} from "./tasks.js";

/** Electron utilityProcess exposes a parentPort with postMessage/on("message"). */
interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  start?(): void;
}

type ProcessWithParentPort = NodeJS.Process & { parentPort?: ParentPortLike };

/** What the worker posts back: a final response OR a mid-task progress tick (APP-066). */
type Outbound = TaskResponse | TaskProgress;

/** Reply over whichever transport we bound to. */
function makeReply(): (res: Outbound) => void {
  const proc = process as ProcessWithParentPort;
  const parentPort = proc.parentPort;

  if (parentPort && typeof parentPort.postMessage === "function") {
    // Electron utilityProcess transport.
    return (res) => parentPort.postMessage(res);
  }
  if (typeof process.send === "function") {
    // Node child_process.fork transport (tests).
    return (res) => {
      process.send?.(res);
    };
  }
  // No transport (ran standalone) — drop replies; runTask still executes.
  return () => {
    /* no parent to reply to */
  };
}

/**
 * Handle one inbound message: validate → run → reply. Never throws to the loop.
 * A `{cancel:id}` control message flags that id in `cancelled` so an in-flight walk
 * that polls `shouldCancel` stops early (APP-066); progress ticks stream back live.
 */
function handle(raw: unknown, reply: (res: Outbound) => void, cancelled: Set<string>): void {
  if (isCancelMessage(raw)) {
    cancelled.add(raw.cancel);
    return;
  }
  if (!isTaskRequest(raw)) return; // ignore other control messages.
  let res: TaskResponse;
  try {
    res = runTask(raw, {
      onProgress: (scanned) => reply({ id: raw.id, kind: raw.kind, progress: { scanned } }),
      shouldCancel: () => cancelled.has(raw.id),
    });
  } catch (e) {
    res = {
      id: raw.id,
      kind: raw.kind,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  cancelled.delete(raw.id); // task done — forget any cancel flag for this id.
  reply(res);
}

/** Bind the inbound channel to handler. Returns a disposer (used by tests). */
export function startWorker(): () => void {
  const reply = makeReply();
  const cancelled = new Set<string>(); // ids the host asked to cancel (APP-066)
  const proc = process as ProcessWithParentPort;
  const parentPort = proc.parentPort;

  if (parentPort && typeof parentPort.on === "function") {
    const onMessage = (e: { data: unknown }) => handle(e.data, reply, cancelled);
    parentPort.on("message", onMessage);
    if (typeof parentPort.start === "function") parentPort.start();
    return () => {
      /* utilityProcess parentPort has no off(); process exit tears it down. */
    };
  }

  const onMessage = (msg: unknown) => handle(msg, reply, cancelled);
  process.on("message", onMessage);
  return () => process.off("message", onMessage);
}

// Auto-start when executed as a process entry (both fork and utilityProcess run
// this module top-level). Guarded so importing it in a test doesn't double-bind:
// a test imports the pure fns from tasks.ts, not this entry.
if (process.env.PROM_WORKER_NO_AUTOSTART !== "1") {
  startWorker();
}
