/**
 * main/worker-host.ts — the MAIN-process manager for the offloaded WORKER process
 * (file 01 §5, the worker layer). NO electron import.
 *
 * The Electron renderer must never do heavy CPU/IO (it would jank the UI), and
 * the MAIN process must stay responsive too — so heavy work (log aggregation over
 * a large stderr blob, walking a directory tree) is OFFLOADED to a dedicated
 * worker process. In production that worker is an Electron `utilityProcess`; here
 * the host is decoupled from Electron by accepting a SPAWN FUNCTION, so node:test
 * forks a plain Node child (worker/index.ts) and drives the exact same protocol.
 *
 * The host owns:
 *   - a single (lazily-spawned) worker child,
 *   - a request/response correlation table (id → pending promise),
 *   - a per-request timeout (fail-closed: a hung worker rejects, never hangs),
 *   - crash handling: if the worker dies, all in-flight requests reject and the
 *     next request re-spawns it (self-healing, bounded by the caller's retries).
 *
 * It speaks the SAME typed TaskRequest/TaskResponse protocol defined in
 * worker/tasks.ts, so the contract can never drift between host and worker.
 *
 * Node built-ins only: node:events. The transport handle is injected.
 */

import { EventEmitter } from "node:events";

import type { TaskKind, TaskRequest, TaskResponse } from "../worker/tasks.js";
import { isTaskProgress } from "../worker/tasks.js";

/**
 * The minimal duck-typed handle the host needs from whatever it spawned. Both
 * an Electron utilityProcess and a node:child_process `fork` satisfy this, so
 * the host code is identical in prod and under test.
 */
export interface WorkerHandle {
  /** post a structured-clone-safe message to the worker. */
  postMessage(message: unknown): void;
  /** subscribe to messages FROM the worker. */
  on(event: "message", listener: (message: unknown) => void): void;
  /** subscribe to the worker's exit. */
  on(event: "exit", listener: (code: number | null) => void): void;
  /** subscribe to a spawn/transport error. */
  on(event: "error", listener: (err: Error) => void): void;
  /** terminate the worker. Returns void or boolean depending on backend. */
  kill?(): void;
  terminate?(): void;
}

/** The factory the host calls to (re)create a worker. Injected for testability. */
export type SpawnWorker = () => WorkerHandle;

export interface WorkerHostOptions {
  /** the factory that produces a fresh worker handle (utilityProcess OR fork). */
  spawn: SpawnWorker;
  /** per-request timeout in ms (fail-closed). Default 30s. */
  requestTimeoutMs?: number;
  /** monotonic id source (injectable for deterministic tests). */
  idSource?: () => string;
  /** clock for the crash-loop backoff window (injectable for deterministic tests). */
  now?: () => number;
}

/** Crash-loop backoff: a broken worker must not become a tight re-spawn fork-bomb. */
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 5_000;

interface Pending {
  resolve: (res: TaskResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  kind: TaskKind;
  /** APP-066: mid-task progress sink (optional); each tick RESETS the idle timeout. */
  onProgress?: (progress: { scanned: number }) => void;
}

/** Per-request options (APP-066): a caller-supplied id (for cancel) + a progress sink. */
export interface RunOptions {
  /** external correlation id so the caller can `cancel(id)` a specific in-flight task. */
  id?: string;
  /** called on each mid-task progress tick; also resets the per-request idle timeout. */
  onProgress?: (progress: { scanned: number }) => void;
}

/** Events the host emits so the MAIN process can log worker lifecycle. */
export interface WorkerHostEvents {
  spawned: [];
  crashed: [{ code: number | null; inFlight: number }];
  error: [Error];
}

/**
 * Drives a single offloaded worker. Construct ONE per MAIN process; it lazily
 * spawns the worker on first request and re-spawns after a crash.
 */
export class WorkerHost extends EventEmitter {
  private readonly spawn: SpawnWorker;
  private readonly requestTimeoutMs: number;
  private readonly nextId: () => string;

  private worker: WorkerHandle | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private disposed = false;
  private readonly now: () => number;
  private consecutiveCrashes = 0;
  private lastCrashAt = 0;

  constructor(opts: WorkerHostOptions) {
    super();
    this.spawn = opts.spawn;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.nextId = opts.idSource ?? (() => `w${++this.seq}`);
    this.now = opts.now ?? Date.now;
  }

  // --- typed EventEmitter overrides ------------------------------------- //
  override on<K extends keyof WorkerHostEvents>(
    event: K,
    listener: (...args: WorkerHostEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof WorkerHostEvents>(event: K, ...args: WorkerHostEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  /** Is a worker process currently alive? */
  get isRunning(): boolean {
    return this.worker !== null;
  }

  /** How many requests are awaiting a response right now. */
  get inFlight(): number {
    return this.pending.size;
  }

  /** Spawn the worker if it isn't already running. Idempotent. */
  private ensureWorker(): WorkerHandle {
    if (this.worker) return this.worker;
    // crash-loop backoff: the FIRST respawn after a crash is immediate (normal
    // recovery), but after REPEATED rapid crashes we refuse to re-spawn so a broken
    // worker binary can't fork-bomb. The window grows exponentially (capped) and
    // resets the moment a worker answers a request (see onMessage).
    if (this.consecutiveCrashes > 1) {
      const backoff = Math.min(
        BACKOFF_BASE_MS * 2 ** (this.consecutiveCrashes - 2),
        BACKOFF_MAX_MS,
      );
      const waited = this.now() - this.lastCrashAt;
      if (waited < backoff) {
        throw new Error(
          `worker in crash-loop backoff (${this.consecutiveCrashes} crashes) — retry in ${
            backoff - waited
          }ms`,
        );
      }
    }
    const w = this.spawn();
    this.worker = w;

    w.on("message", (msg: unknown) => this.onMessage(msg));
    w.on("exit", (code: number | null) => this.onExit(code));
    w.on("error", (err: Error) => {
      this.emit("error", err);
      // an unrecoverable transport error behaves like a crash.
      this.onExit(null);
    });

    this.emit("spawned");
    return w;
  }

  private onMessage(msg: unknown): void {
    // APP-066: a mid-task progress tick — route to the request's sink and RESET the
    // idle timeout so a legitimately long walk isn't force-timed-out mid-work. It does
    // NOT resolve the request (no `ok`) and does NOT clear the crash-loop backoff.
    if (isTaskProgress(msg)) {
      const pp = this.pending.get(msg.id);
      if (!pp) return;
      pp.onProgress?.(msg.progress);
      this.rearmTimeout(msg.id, pp);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const res = msg as Partial<TaskResponse> & { id?: unknown };
    if (typeof res.id !== "string") return;
    const p = this.pending.get(res.id);
    if (!p) return; // late/duplicate response — ignore.
    clearTimeout(p.timer);
    this.pending.delete(res.id);
    // a successful response proves the worker is healthy → clear the crash-loop backoff.
    this.consecutiveCrashes = 0;
    p.resolve(res as TaskResponse);
  }

  /** Re-arm a pending request's idle timeout (called on each progress tick). */
  private rearmTimeout(id: string, p: Pending): void {
    clearTimeout(p.timer);
    const timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      p.reject(
        new Error(`worker task ${p.kind} (${id}) timed out after ${this.requestTimeoutMs}ms`),
      );
    }, this.requestTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    p.timer = timer;
  }

  /**
   * Cooperatively cancel an in-flight task (APP-066): post a `{cancel:id}` message the
   * worker polls between file batches. A no-op if the id isn't in flight or no worker is
   * up. The worker replies with its (possibly partial) result, which resolves the request
   * normally — the caller inspects `result.cancelled`.
   */
  cancel(id: string): void {
    if (!this.pending.has(id) || !this.worker) return;
    try {
      this.worker.postMessage({ cancel: id });
    } catch {
      /* worker gone — the pending will reject via onExit. */
    }
  }

  /** A worker exit: fail EVERY in-flight request (fail-closed) and drop the handle. */
  private onExit(code: number | null): void {
    const inFlight = this.pending.size;
    this.worker = null;
    // count toward crash-loop backoff (a deliberate dispose() is not a crash).
    if (!this.disposed) {
      this.consecutiveCrashes += 1;
      this.lastCrashAt = this.now();
    }
    if (inFlight > 0) {
      this.emit("crashed", { code, inFlight });
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`worker exited (code ${code ?? "null"}) with a request in flight`));
    }
    this.pending.clear();
  }

  /**
   * Send a task to the worker and await its typed response. Re-spawns the worker
   * if it had crashed. Rejects (fail-closed) on a per-request timeout — a hung
   * worker never hangs the caller.
   */
  run(req: Omit<TaskRequest, "id">, opts?: RunOptions): Promise<TaskResponse> {
    if (this.disposed) {
      return Promise.reject(new Error("WorkerHost is disposed"));
    }
    const id = opts?.id ?? this.nextId();
    const full = { ...req, id } as TaskRequest;

    let worker: WorkerHandle;
    try {
      worker = this.ensureWorker();
    } catch (e) {
      return Promise.reject(
        new Error(`failed to spawn worker: ${e instanceof Error ? e.message : String(e)}`),
      );
    }

    return new Promise<TaskResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(
          new Error(`worker task ${full.kind} (${id}) timed out after ${this.requestTimeoutMs}ms`),
        );
      }, this.requestTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const pending: Pending = { resolve, reject, timer, kind: full.kind };
      if (opts?.onProgress) pending.onProgress = opts.onProgress;
      this.pending.set(id, pending);

      try {
        worker.postMessage(full);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new Error(`failed to post task to worker: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    });
  }

  /** Terminate the worker and reject any in-flight requests. */
  dispose(): void {
    this.disposed = true;
    const w = this.worker;
    this.worker = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("WorkerHost disposed"));
    }
    this.pending.clear();
    if (w) {
      try {
        if (typeof w.terminate === "function") w.terminate();
        else if (typeof w.kill === "function") w.kill();
      } catch {
        /* already dead */
      }
    }
  }
}
