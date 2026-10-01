// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/run-host.ts — named run sessions for launch.json configs (APP-032).
 *
 * Executes ONE resolved run invocation (built by the renderer's PURE
 * `buildRunInvocation`) through the SAME `PtyBackend` seam the terminal uses —
 * node-pty spawns argv ARRAYS with no shell, and its process group means
 * `kill()` reaches the child tree on POSIX. Output is a merged stdout+stderr
 * byte stream (a pty has no separate stderr fd); exit reports `{exitCode,
 * signal?, killed}` so the panel can tell "exited 0" from "killed".
 *
 * The renderer NEVER spawns (C5) and this host NEVER decides "safe": ide-ipc
 * runs the fail-closed engine run-gate + the 90% CPU/RAM telemetry launch guard
 * BEFORE `start()` is ever called. Defence-in-depth here: the request env is
 * re-sanitized against the loader-hijack denylist even though the renderer's
 * builder already stripped it — a compromised renderer must not smuggle
 * LD_PRELOAD through the invocation.
 *
 * Node built-ins only; the backend is injected (fake in tests, node-pty live).
 */

import { EventEmitter } from "node:events";

import { isHijackEnvKey } from "@prometheus/engine-bridge";

import {
  type ActiveVenv,
  type PtyBackend,
  type PtyProcess,
  buildVenvEnv,
  processEnvSnapshot,
} from "./pty-host.js";

/**
 * Keys a run request may never override, ON TOP of engine-bridge's hijack denylist.
 *
 * Only `PATH` lives here. `isHijackEnvKey` deliberately permits it — every child it curates
 * needs to find its interpreter — but a run request is USER-SUPPLIED input, and letting it
 * repoint `PATH` chooses which binary `cmd` resolves to.
 *
 * This file used to carry its own seven-name list described as a "mirror" of engine-bridge's.
 * It was not: engine-bridge strips fifteen names plus every `DYLD_*`, and the ten missing here
 * included `BASH_ENV`, `ENV`, `PYTHONSTARTUP`, `PYTHONPATH`, `LD_AUDIT` and `DYLD_*` beyond the
 * two named — so a run request could set `PYTHONSTARTUP` and execute code in the child before
 * its first line ran. Two copies of a security denylist do not stay in step; the copy simply
 * permits more as the real list grows. See `isHijackEnvKey`.
 */
const EXTRA_DENIED_KEYS = new Set(["PATH"]);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Strip malformed and hijack-class keys from a run request's env overrides. */
export function sanitizeRunEnvKeys(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_KEY.test(k)) continue;
    if (EXTRA_DENIED_KEYS.has(k.toUpperCase()) || isHijackEnvKey(k)) continue;
    out[k] = v;
  }
  return out;
}

/** What ide-ipc passes to start a run (already gated + guard-cleared). */
export interface RunStartRequest {
  cmd: string;
  args: string[];
  cwd: string;
  /** user env overrides (values only — keys re-sanitized here). */
  env?: Record<string, string>;
  /** the active venv to inherit (same semantics as a terminal spawn). */
  venv?: ActiveVenv | null;
}

/** A serialisable snapshot of one run session. */
export interface RunStatus {
  runId: string;
  cmd: string;
  cwd: string;
  alive: boolean;
  exitCode?: number;
  signal?: number;
  killed?: boolean;
}

export interface RunHostEvents {
  /** a chunk of merged stdout+stderr output. */
  data: [{ runId: string; data: string }];
  /** the run finished. `killed` = stopped by the user (kill()), not a natural exit. */
  exit: [{ runId: string; exitCode: number; signal?: number; killed: boolean }];
}

export interface RunHostOptions {
  backend: PtyBackend;
  /** the base env runs start from (default: process.env snapshot). */
  baseEnv?: Record<string, string>;
  /** id minter (injectable). Default a counter. */
  mintId?: () => string;
  /** ms between the kill() SIGTERM and the SIGKILL escalation. Default 3000. */
  killGraceMs?: number;
  /** timer seam (tests make it synchronous). */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
}

interface RunSession {
  runId: string;
  cmd: string;
  cwd: string;
  proc: PtyProcess;
  alive: boolean;
  killed: boolean;
  exitCode?: number;
  signal?: number;
  killTimer?: NodeJS.Timeout | number;
}

/** The run host: gated named spawns with live output + exit/kill capture. */
export class RunHost extends EventEmitter {
  private readonly backend: PtyBackend;
  private readonly baseEnv: Record<string, string>;
  private readonly mintId: () => string;
  private readonly killGraceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  private readonly runs = new Map<string, RunSession>();
  private idCounter = 0;
  private disposed = false;

  constructor(opts: RunHostOptions) {
    super();
    this.backend = opts.backend;
    this.baseEnv = opts.baseEnv ?? processEnvSnapshot();
    this.mintId = opts.mintId ?? (() => `run-${++this.idCounter}`);
    this.killGraceMs = opts.killGraceMs ?? 3000;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  override on<K extends keyof RunHostEvents>(
    event: K,
    listener: (...args: RunHostEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof RunHostEvents>(event: K, ...args: RunHostEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  /** Spawn a run session (argv array, venv-inherited env, no shell). */
  start(req: RunStartRequest): { runId: string } {
    if (this.disposed) throw new Error("RunHost disposed");
    const runId = this.mintId();
    const env = {
      ...buildVenvEnv(this.baseEnv, req.venv),
      ...sanitizeRunEnvKeys(req.env),
    };
    const proc = this.backend.spawn({
      shell: req.cmd,
      args: req.args,
      cwd: req.cwd,
      env,
    });
    const run: RunSession = { runId, cmd: req.cmd, cwd: req.cwd, proc, alive: true, killed: false };
    this.runs.set(runId, run);
    proc.onData((data) => this.emit("data", { runId, data }));
    proc.onExit((e) => {
      run.alive = false;
      run.exitCode = e.exitCode;
      if (e.signal !== undefined) run.signal = e.signal;
      if (run.killTimer !== undefined) clearTimeout(run.killTimer as NodeJS.Timeout);
      this.emit("exit", {
        runId,
        exitCode: e.exitCode,
        ...(e.signal !== undefined ? { signal: e.signal } : {}),
        killed: run.killed,
      });
      this.runs.delete(runId);
    });
    return { runId };
  }

  /** Stop a run: SIGTERM first, SIGKILL after the grace period (POSIX pty kill
   *  reaches the process group, so the child tree stops too). */
  kill(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || !run.alive) return false;
    run.killed = true;
    try {
      run.proc.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    run.killTimer = this.setTimer(() => {
      if (!run.alive) return;
      try {
        run.proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, this.killGraceMs);
    return true;
  }

  /** A serialisable snapshot of one run (or undefined). */
  status(runId: string): RunStatus | undefined {
    const r = this.runs.get(runId);
    if (!r) return undefined;
    return {
      runId: r.runId,
      cmd: r.cmd,
      cwd: r.cwd,
      alive: r.alive,
      ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
      ...(r.signal !== undefined ? { signal: r.signal } : {}),
      ...(r.killed ? { killed: true } : {}),
    };
  }

  /** Kill every live run (app shutdown). */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.runs.keys()]) this.kill(id);
  }
}

/* ── the gated start orchestration (pure over injected deps — ide-ipc relays) ── */

/** The subset of gate.ts's RunGateResult this flow consumes. */
export interface GateVerdictLike {
  mayLaunch: boolean;
  reason: string;
}

/** The subset of SystemTelemetry the launch guard consumes. */
export interface TelemetryLike {
  guard: { allow: boolean; reason?: string };
}

export interface GatedRunDeps {
  /** the fail-closed engine run-gate (gate.ts runGate, injected for tests). */
  gate(id: { workspaceRoot: string; head?: string }): Promise<GateVerdictLike>;
  /** the telemetry reader — a THROW blocks the launch (fail-closed). */
  readTelemetry(): Promise<TelemetryLike>;
  /** the spawner (RunHost.start, injected for tests). */
  start(req: RunStartRequest): { runId: string };
}

export interface GatedRunOutcome {
  ok: boolean;
  runId?: string;
  refusedBy?: "gate" | "guard";
  gateReason?: string;
  error?: string;
}

/**
 * The APP-032 launch spine — order is NON-NEGOTIABLE and fail-closed at every
 * step: engine run-gate → 90% CPU/RAM telemetry guard (an unreadable telemetry
 * BLOCKS; never spawn in the catch) → spawn. A refusal names its stage and
 * carries the reason; NO process exists unless both checks passed.
 */
export async function startGatedRun(
  req: RunStartRequest & { workspaceRoot: string; head?: string },
  deps: GatedRunDeps,
): Promise<GatedRunOutcome> {
  const verdict = await deps.gate({
    workspaceRoot: req.workspaceRoot,
    ...(req.head !== undefined ? { head: req.head } : {}),
  });
  if (!verdict.mayLaunch) {
    return { ok: false, refusedBy: "gate", gateReason: verdict.reason, error: verdict.reason };
  }
  try {
    const tele = await deps.readTelemetry();
    if (!tele.guard.allow) {
      return {
        ok: false,
        refusedBy: "guard",
        error: tele.guard.reason ?? "resource guard refused the launch",
      };
    }
  } catch (e) {
    return {
      ok: false,
      refusedBy: "guard",
      error: `telemetry unavailable (${e instanceof Error ? e.message : String(e)}) — launch held until a reading succeeds`,
    };
  }
  try {
    const { runId } = deps.start(req);
    return { ok: true, runId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
