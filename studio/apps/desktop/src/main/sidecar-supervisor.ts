// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/sidecar-supervisor.ts — the MAIN-process sidecar supervisor (file 01 §5,
 * §Open-Q2). PLAIN Node module: node:child_process + node:events ONLY, NO
 * electron import — so node:test exercises every branch right now.
 *
 * file 01 §Open-Q2 asks: do we spawn the engine PER COMMAND (a fresh one-shot
 * `python3 prometheus.py --json …` that emits ONE JSON object and exits) or keep
 * a SUPERVISED LONG-LIVED child for streaming/interactive ops? The answer is
 * BOTH, and this supervisor provides both modes behind one typed surface:
 *
 *   • runOnce(argv)         — per-command mode. Delegates to engine-bridge
 *                             (the ONLY sanctioned python3 spawner, C5). Each
 *                             call is an isolated process; fail-closed on
 *                             missing/timeout/unparseable (engine-bridge already
 *                             guarantees this — we never upgrade to "safe").
 *
 *   • startLongLived(spec)  — supervised mode. Owns a long-lived child for a
 *                             streaming sidecar (e.g. a future `--watch`/serve
 *                             loop). Adds a RESTART POLICY: max retries, capped
 *                             exponential backoff, a health check, a crash event,
 *                             and a graceful (SIGTERM→SIGKILL) shutdown.
 *
 * The long-lived child is spawned through an INJECTABLE spawn function (defaults
 * to node:child_process.spawn) so tests drive the restart state machine with a
 * fake/echo process and never need a real long-running binary. Per C5 the
 * one-shot path NEVER bypasses engine-bridge; the long-lived path is for Studio
 * sidecars the MAIN process owns (C7/C8), not for prometheus.py/nemesis verdicts.
 *
 * Node built-ins only: node:child_process, node:events.
 */

import { type ChildProcess, type SpawnOptions, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  type EngineClient,
  type EngineConfig,
  type EngineEnvelope,
  type RunOptions,
  createEngineClient,
  resolveEngine,
} from "@prometheus/engine-bridge";

/* ════════════════════════════════════════════════════════════════════════════
 * PER-COMMAND (one-shot) MODE — thin, fail-closed wrapper over engine-bridge.
 * ══════════════════════════════════════════════════════════════════════════ */

export interface OneShotOptions extends RunOptions {
  /** for symmetry with RunOptions; timeoutMs/cwd/signal/onStderr all honoured. */
}

/* ════════════════════════════════════════════════════════════════════════════
 * SUPERVISED LONG-LIVED MODE — restart policy state machine.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Lifecycle states a long-lived sidecar moves through. */
export type SidecarState =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "stopping"
  | "stopped"
  | "failed";

/** Restart policy knobs (sensible defaults applied in the supervisor). */
export interface RestartPolicy {
  /** max automatic restarts before giving up and entering "failed". Default 5. */
  maxRetries?: number;
  /** base backoff (ms) for the FIRST restart; grows exponentially. Default 500. */
  baseBackoffMs?: number;
  /** cap on the backoff (ms) so it never grows unbounded. Default 30_000. */
  maxBackoffMs?: number;
  /**
   * a run that stays up at least this long (ms) RESETS the retry counter — a
   * sidecar that ran fine for a while then died is a fresh fault, not a crash
   * loop. Default 10_000.
   */
  healthyAfterMs?: number;
  /** grace period (ms) for SIGTERM before SIGKILL on stop. Default 5_000. */
  graceMs?: number;
}

/** The spec describing a long-lived sidecar to supervise. */
export interface LongLivedSpec {
  /** stable id (one supervised child per id). */
  id: string;
  /** executable to run (absolute path or PATH-resolved name). */
  command: string;
  /** argv passed verbatim (shell:false — no injection). */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** restart policy overrides. */
  policy?: RestartPolicy;
}

/** Serialisable status snapshot (no live ChildProcess handle leaks out). */
export interface SidecarStatus {
  id: string;
  state: SidecarState;
  pid?: number;
  restarts: number;
  startedAt?: string;
  stoppedAt?: string;
  lastExitCode?: number | null;
  lastSignal?: NodeJS.Signals | null;
  lastError?: string;
  /** true when state==="running" and the child handle is live. */
  healthy: boolean;
}

/** The minimal child handle the supervisor relies on (real OR fake). */
export interface ChildLike {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  stdout?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
}

/**
 * The spawn function the long-lived supervisor uses. Injectable: tests pass a
 * fake that returns a controllable EventEmitter-backed child so the restart
 * state machine runs without a real binary. Defaults to node:child_process.spawn.
 */
export type ChildSpawner = (command: string, args: string[], options: SpawnOptions) => ChildLike;

const defaultSpawner: ChildSpawner = (command, args, options) =>
  nodeSpawn(command, args, options) as unknown as ChildLike;

/** Events the supervisor emits (typed). */
export interface SidecarSupervisorEvents {
  starting: [SidecarStatus];
  running: [SidecarStatus];
  /** the child exited unexpectedly and a restart is scheduled. */
  crashed: [SidecarStatus];
  /** a scheduled restart is being attempted. */
  restarting: [SidecarStatus];
  stopped: [SidecarStatus];
  /** retries exhausted — no more automatic restarts. */
  failed: [SidecarStatus];
  /** a line of the child's stdout/stderr (id, stream, line). */
  log: [string, "stdout" | "stderr", string];
}

interface Supervised {
  spec: LongLivedSpec;
  policy: Required<RestartPolicy>;
  state: SidecarState;
  child: ChildLike | null;
  restarts: number;
  startedAt?: string;
  stoppedAt?: string;
  lastExitCode?: number | null;
  lastSignal?: NodeJS.Signals | null;
  lastError?: string;
  /** wall-clock ms of the last successful spawn (for healthyAfterMs). */
  lastSpawnAt?: number;
  /** pending restart timer so stop() can cancel it. */
  restartTimer?: ReturnType<typeof setTimeout>;
  /** set true by stop() so the exit handler does NOT auto-restart. */
  intentionalStop: boolean;
  /** resolves when the child has fully exited (for stop()). */
  exitWaiters: Array<() => void>;
}

const DEFAULT_POLICY: Required<RestartPolicy> = {
  maxRetries: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
  healthyAfterMs: 10_000,
  graceMs: 5_000,
};

export interface SidecarSupervisorOptions {
  /** engine config threaded into the one-shot engine-bridge client (C2). */
  engineConfig?: EngineConfig;
  /** injectable spawner for the long-lived path (tests). */
  spawner?: ChildSpawner;
  /** injectable clock for deterministic health/backoff tests. */
  now?: () => number;
}

/** Result of the engine version probe (`prometheus.py --version`). */
export interface EngineVersionResult {
  ok: boolean;
  version?: string;
  error?: string;
}

/**
 * SidecarSupervisor — the dual-mode (per-command + long-lived) MAIN-process
 * sidecar manager. Construct ONE per Studio MAIN process.
 */
export class SidecarSupervisor extends EventEmitter {
  private readonly engine: EngineClient;
  private readonly engineConfig: EngineConfig;
  private readonly spawner: ChildSpawner;
  private readonly now: () => number;
  private readonly supervised = new Map<string, Supervised>();
  private disposed = false;

  constructor(opts: SidecarSupervisorOptions = {}) {
    super();
    this.engineConfig = opts.engineConfig ?? {};
    this.engine = createEngineClient(this.engineConfig);
    this.spawner = opts.spawner ?? defaultSpawner;
    this.now = opts.now ?? Date.now;
  }

  // --- typed EventEmitter overrides ------------------------------------- //
  override on<K extends keyof SidecarSupervisorEvents>(
    event: K,
    listener: (...args: SidecarSupervisorEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof SidecarSupervisorEvents>(
    event: K,
    ...args: SidecarSupervisorEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  /* ── PER-COMMAND (one-shot) MODE ────────────────────────────────────────
   * Delegates to engine-bridge — the ONLY sanctioned python3 spawner (C5).
   * Each call is an isolated process; engine-bridge fails closed on a
   * missing script / timeout / unparseable stdout (a rejected promise), and
   * RETURNS ok:false/forced_danger envelopes (valid engine output) — we never
   * convert a block into a success.
   */

  /** Run a one-shot engine command (`python3 prometheus.py --json <argv…>`). */
  runOnce<T extends EngineEnvelope = EngineEnvelope>(
    argv: string[],
    opts: OneShotOptions = {},
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("SidecarSupervisor disposed"));
    return this.engine.runPrometheus<T>(argv, opts);
  }

  /** Expose the underlying one-shot client for typed verbs (scan/list/gate…). */
  get oneShot(): EngineClient {
    return this.engine;
  }

  /**
   * Probe the engine's SCRIPT_VERSION via `python3 prometheus.py --version`.
   * argparse prints "prometheus.py X.Y.Z" as PLAIN TEXT and exits — it is NOT a
   * JSON envelope, so this cannot go through runPrometheus (which forces --json
   * and parses an envelope). We resolve the SAME python/script paths engine-bridge
   * uses (resolveEngine) and spawn a short-lived child, parsing the trailing
   * version token. This is a benign capability probe, not a security decision (C5).
   */
  engineVersion(timeoutMs = 10_000): Promise<EngineVersionResult> {
    const { prometheusPy, pythonBin } = resolveEngine(this.engineConfig);
    return new Promise<EngineVersionResult>((resolve) => {
      let child: ChildLike;
      try {
        child = this.spawner(pythonBin, [prometheusPy, "--version"], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
        return;
      }

      let out = "";
      let settled = false;
      const done = (r: EngineVersionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        done({ ok: false, error: `version probe timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      // --version prints to stdout under argparse; some shells route to stderr —
      // capture both and scan for the "name X.Y.Z" token.
      child.stdout?.on("data", (b: Buffer) => {
        out += b.toString();
      });
      child.stderr?.on("data", (b: Buffer) => {
        out += b.toString();
      });

      child.on("error", (err: Error) => done({ ok: false, error: err.message }));
      child.on("exit", () => {
        const m = out.match(/(\d+\.\d+\.\d+(?:[-.\w]*)?)/);
        if (m?.[1]) done({ ok: true, version: m[1] });
        else done({ ok: false, error: out.trim() || "no version produced" });
      });
    });
  }

  /* ── SUPERVISED LONG-LIVED MODE ─────────────────────────────────────────── */

  /** Serialisable status of one supervised sidecar (or undefined if unknown). */
  status(id: string): SidecarStatus | undefined {
    const s = this.supervised.get(id);
    return s ? this.toStatus(s) : undefined;
  }

  /** Serialisable status of every supervised sidecar. */
  list(): SidecarStatus[] {
    return [...this.supervised.values()].map((s) => this.toStatus(s));
  }

  /** Liveness health for one sidecar (running + a live child handle). */
  health(id: string): { id: string; healthy: boolean; state: SidecarState } {
    const s = this.supervised.get(id);
    return {
      id,
      state: s?.state ?? "idle",
      healthy: !!s && s.state === "running" && s.child !== null,
    };
  }

  /**
   * Start (or no-op if already up) a supervised long-lived sidecar. Idempotent:
   * starting a running id returns its current status without re-spawning.
   */
  startLongLived(spec: LongLivedSpec): SidecarStatus {
    if (this.disposed) throw new Error("SidecarSupervisor disposed");

    const existing = this.supervised.get(spec.id);
    if (
      existing &&
      (existing.state === "running" ||
        existing.state === "starting" ||
        existing.state === "restarting")
    ) {
      return this.toStatus(existing);
    }

    const entry: Supervised = existing ?? {
      spec,
      policy: { ...DEFAULT_POLICY, ...spec.policy },
      state: "idle",
      child: null,
      restarts: 0,
      intentionalStop: false,
      exitWaiters: [],
    };
    // refresh spec/policy in case the caller passed new values.
    entry.spec = spec;
    entry.policy = { ...DEFAULT_POLICY, ...spec.policy };
    entry.intentionalStop = false;
    entry.lastError = undefined;
    this.supervised.set(spec.id, entry);

    this.spawnChild(entry, /*isRestart*/ false);
    return this.toStatus(entry);
  }

  /** The actual spawn + wiring of a supervised child (used by start + restart). */
  private spawnChild(entry: Supervised, isRestart: boolean): void {
    entry.state = isRestart ? "restarting" : "starting";
    this.emit(isRestart ? "restarting" : "starting", this.toStatus(entry));

    let child: ChildLike;
    try {
      child = this.spawner(entry.spec.command, entry.spec.args ?? [], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: entry.spec.cwd,
        env: entry.spec.env ? { ...process.env, ...entry.spec.env } : process.env,
      });
    } catch (err) {
      entry.child = null;
      entry.lastError = err instanceof Error ? err.message : String(err);
      this.handleExitFault(entry, null, null);
      return;
    }

    entry.child = child;
    entry.lastSpawnAt = this.now();
    entry.startedAt = new Date().toISOString();
    entry.stoppedAt = undefined;
    entry.state = "running";
    this.emit("running", this.toStatus(entry));

    child.stdout?.on("data", (b: Buffer) =>
      this.emit("log", entry.spec.id, "stdout", b.toString()),
    );
    child.stderr?.on("data", (b: Buffer) =>
      this.emit("log", entry.spec.id, "stderr", b.toString()),
    );

    child.on("error", (err: Error) => {
      entry.lastError = err.message;
      // an error without an exit still drops the handle → treat as a fault.
    });

    child.on("exit", (code, signal) => {
      entry.child = null;
      entry.lastExitCode = code;
      entry.lastSignal = signal;
      entry.stoppedAt = new Date().toISOString();

      if (entry.intentionalStop) {
        // Set the TERMINAL state BEFORE waking stop() waiters so the resolved
        // status reads "stopped" (not the transient "stopping").
        entry.state = "stopped";
        const waiters = entry.exitWaiters.splice(0);
        for (const w of waiters) w();
        this.emit("stopped", this.toStatus(entry));
        return;
      }

      // Unexpected exit → fault path (crash + maybe restart). Wake any waiters
      // (there should be none mid-fault) so a racing stop() never hangs.
      const waiters = entry.exitWaiters.splice(0);
      for (const w of waiters) w();
      this.handleExitFault(entry, code, signal);
    });
  }

  /**
   * Handle an UNEXPECTED exit/spawn-failure: decide whether to restart under the
   * policy. A run that was healthy long enough resets the retry counter.
   */
  private handleExitFault(
    entry: Supervised,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    // Reset the retry counter if the last run stayed up past healthyAfterMs.
    if (
      entry.lastSpawnAt !== undefined &&
      this.now() - entry.lastSpawnAt >= entry.policy.healthyAfterMs
    ) {
      entry.restarts = 0;
    }

    entry.state = "failed"; // provisional; flips to restarting if we retry.
    if (entry.lastError === undefined && code !== null && code !== 0) {
      entry.lastError = `exited with code ${code}`;
    } else if (entry.lastError === undefined && signal) {
      entry.lastError = `killed by signal ${signal}`;
    }
    this.emit("crashed", this.toStatus(entry));

    if (entry.restarts >= entry.policy.maxRetries) {
      entry.state = "failed";
      this.emit("failed", this.toStatus(entry));
      return;
    }

    entry.restarts += 1;
    const backoff = Math.min(
      entry.policy.baseBackoffMs * 2 ** (entry.restarts - 1),
      entry.policy.maxBackoffMs,
    );
    entry.state = "restarting";
    const timer = setTimeout(() => {
      entry.restartTimer = undefined;
      if (entry.intentionalStop || this.disposed) return;
      this.spawnChild(entry, /*isRestart*/ true);
    }, backoff);
    if (typeof timer.unref === "function") timer.unref();
    entry.restartTimer = timer;
  }

  /**
   * Stop a supervised sidecar: cancel any pending restart, then SIGTERM and
   * escalate to SIGKILL after graceMs. Resolves once the child has exited (or
   * immediately if already stopped). Sets intentionalStop so the exit handler
   * does NOT auto-restart.
   */
  stop(id: string): Promise<SidecarStatus> {
    const entry = this.supervised.get(id);
    if (!entry) {
      return Promise.resolve({ id, state: "stopped", restarts: 0, healthy: false });
    }

    entry.intentionalStop = true;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }

    const child = entry.child;
    if (!child) {
      entry.state = "stopped";
      this.emit("stopped", this.toStatus(entry));
      return Promise.resolve(this.toStatus(entry));
    }

    entry.state = "stopping";

    return new Promise<SidecarStatus>((resolve) => {
      entry.exitWaiters.push(() => resolve(this.toStatus(entry)));

      try {
        child.kill("SIGTERM");
      } catch {
        // already dead — synthesise the stopped state.
        entry.child = null;
        entry.state = "stopped";
        const waiters = entry.exitWaiters.splice(0);
        for (const w of waiters) w();
        return;
      }

      const killTimer = setTimeout(() => {
        if (entry.child) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }, entry.policy.graceMs);
      if (typeof killTimer.unref === "function") killTimer.unref();
    });
  }

  /** Stop every supervised sidecar (parallel). Used on app shutdown. */
  async stopAll(): Promise<SidecarStatus[]> {
    return Promise.all([...this.supervised.keys()].map((id) => this.stop(id)));
  }

  /** Tear down: stop everything and refuse further work. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopAll();
    for (const entry of this.supervised.values()) {
      if (entry.restartTimer) clearTimeout(entry.restartTimer);
    }
  }

  private toStatus(s: Supervised): SidecarStatus {
    return {
      id: s.spec.id,
      state: s.state,
      pid: s.child?.pid,
      restarts: s.restarts,
      startedAt: s.startedAt,
      stoppedAt: s.stoppedAt,
      lastExitCode: s.lastExitCode,
      lastSignal: s.lastSignal,
      lastError: s.lastError,
      healthy: s.state === "running" && s.child !== null,
    };
  }
}
