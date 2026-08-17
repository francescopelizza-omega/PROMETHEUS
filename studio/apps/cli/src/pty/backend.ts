/**
 * pty/backend.ts — the CLI's pseudo-terminal backend seam (P5).
 *
 * The interactive `prometheus chat --cli X --open` flow has to SPAWN the engine-previewed
 * argv as a live child. The ideal transport is a real PTY (node-pty) so the child
 * believes it owns a terminal (isatty → colors, prompts, paging). But node-pty is a
 * NATIVE addon that is `external` in the build and NOT installed in this env, so we
 * MUST degrade gracefully: when node-pty is absent we fall back to a plain
 * `node:child_process.spawn` with piped stdio. The fallback is a "good-enough" PTY —
 * write/onData/onExit/kill work; `resize` is a best-effort no-op (a piped child has
 * no controlling tty to resize). The session never crashes when either path fails.
 *
 * LAYERING (correct on purpose): the desktop main process already has a richer
 * pty-host (apps/desktop/src/main/ide/pty-host.ts). We do NOT import across the
 * app boundary — the CLI RE-DECLARES the tiny PtyBackend/PtyProcess/PtySpawnOptions
 * interfaces here (they are a stable, minimal contract) and ships its own two impls.
 *
 * EVERYTHING IS TESTABLE WITHOUT A NATIVE ADDON OR A REAL SHELL: node-pty is
 * require()d LAZILY (only on an actual spawn, never at import) through an INJECTED
 * `requireFn` seam, and the child_process fallback spawns through an INJECTED
 * `spawnFn` seam. The sibling test drives both paths with a fake require + a fake
 * spawner — no node-pty, no `/dev/pts`, no child ever runs.
 *
 * Node built-ins only (lazy): node:child_process for the fallback; node-pty is the
 * optional native addon, required lazily and only when present.
 */
import { trackChild } from "../child-reaper.js";

/* ------------------------------------------------------------------------- *
 * The PtyBackend contract (re-declared locally — NOT imported from desktop)
 * ------------------------------------------------------------------------- */

/** Options to spawn one pty/child (cwd/env are already resolved + injection-safe). */
export interface PtySpawnOptions {
  shell: string;
  args?: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

/** A live pty/child the backend returns (the IPty subset the CLI drives). */
export interface PtyProcess {
  pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
}

/** The backend the live-terminal spawns through (injectable). */
export interface PtyBackend {
  spawn(opts: PtySpawnOptions): PtyProcess;
}

/* ------------------------------------------------------------------------- *
 * Injectable seams (so both backends are fully faked in the test)
 * ------------------------------------------------------------------------- */

/** The minimal node-pty surface the adapter uses (kept narrow so the fake is tiny). */
interface NodePtyModule {
  spawn(
    shell: string,
    args: string[],
    o: { cwd: string; env: Record<string, string>; cols: number; rows: number; name?: string },
  ): {
    pid: number;
    write(d: string): void;
    resize(c: number, r: number): void;
    onData(cb: (d: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    kill(s?: string): void;
  };
}

/** A CommonJS-style require (real or faked). Returns `unknown`; the caller narrows. */
export type RequireFn = (moduleId: string) => unknown;

/**
 * The minimal `node:child_process.spawn` surface the fallback drives. Narrowed to
 * the stdio streams + lifecycle we touch so a test fake never needs a real socket.
 */
export interface SpawnedChild {
  pid?: number;
  readonly stdin: { write(data: string): void } | null;
  readonly stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
  readonly stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The `spawn` shape (real or faked) the fallback calls. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; stdio: ["pipe", "pipe", "pipe"] },
) => SpawnedChild;

/** Dependencies for the backend resolver (all default to the real runtime). */
export interface PtyBackendDeps {
  /** force the child_process fallback even if node-pty would resolve (test/opt-out). */
  forceChildProcess?: boolean;
  /** the require used to lazily probe/load node-pty (default: the runtime require). */
  requireFn?: RequireFn;
  /** the spawner the fallback uses (default: lazily require()d node:child_process.spawn). */
  spawnFn?: SpawnFn;
}

/* ------------------------------------------------------------------------- *
 * require / spawn resolution (lazy, crash-free)
 * ------------------------------------------------------------------------- */

/**
 * The ambient CommonJS require, if this module runs under one (the prometheus bin does).
 * Returns undefined under pure ESM with no require shim — callers then degrade.
 */
function runtimeRequire(): RequireFn | undefined {
  const req = (globalThis as { require?: unknown }).require;
  return typeof req === "function" ? (req as RequireFn) : undefined;
}

/** Try to require node-pty through `requireFn`; return the module or null (never throw). */
function tryLoadNodePty(requireFn: RequireFn | undefined): NodePtyModule | null {
  if (!requireFn) return null;
  try {
    const mod = requireFn("node-pty");
    if (mod && typeof (mod as { spawn?: unknown }).spawn === "function") {
      return mod as NodePtyModule;
    }
  } catch {
    // native addon absent / failed to load → fall back. Never crash.
  }
  return null;
}

/**
 * Is node-pty available (can it be required + does it expose `spawn`)? Crash-free:
 * a missing addon returns false, never throws. Honors an injected `requireFn`.
 */
export function nodePtyAvailable(deps?: Pick<PtyBackendDeps, "requireFn">): boolean {
  const requireFn = deps?.requireFn ?? runtimeRequire();
  return tryLoadNodePty(requireFn) !== null;
}

/* ------------------------------------------------------------------------- *
 * Backend A: the node-pty adapter (real PTY when the addon is present)
 * ------------------------------------------------------------------------- */

/**
 * Wrap an already-loaded node-pty module as a PtyBackend. Spawning here yields a
 * real pseudo-terminal so the child gets isatty (colors/prompts/resize all work).
 */
function nodePtyBackend(pty: NodePtyModule): PtyBackend {
  return {
    spawn(opts: PtySpawnOptions): PtyProcess {
      const proc = pty.spawn(opts.shell, opts.args ?? [], {
        cwd: opts.cwd,
        env: opts.env,
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        name: "xterm-color",
      });
      // A terminal pane's shell is a child like any other: if the CLI exits without the
      // pane being closed first, the shell (and everything running in it) is orphaned.
      const untrack = trackChild({
        pid: proc.pid,
        label: `pty:${opts.shell}`,
        command: [opts.shell, ...(opts.args ?? [])].join(" "),
      });
      proc.onExit(() => untrack());
      return {
        pid: proc.pid,
        write: (d) => proc.write(d),
        resize: (c, r) => proc.resize(c, r),
        onData: (cb) => proc.onData(cb),
        onExit: (cb) => proc.onExit(cb),
        kill: (s) => proc.kill(s),
      };
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Backend B: the child_process fallback (no native addon required)
 * ------------------------------------------------------------------------- */

/** Map a node signal NAME (e.g. "SIGINT") to its number for the exit envelope. */
const SIGNAL_NUM: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * Adapt one spawned child to the PtyProcess shape. The child is given piped stdio:
 * stdout + stderr are relayed to onData listeners; stdin takes write()s. There is
 * NO controlling tty, so `resize` is a deliberate best-effort no-op. exit + error
 * both resolve the onExit listeners exactly once (a failed spawn ⇒ exitCode 127),
 * so the live-terminal can always restore the tty and return a code.
 */
class ChildProcessPty implements PtyProcess {
  pid?: number;
  private readonly child: SpawnedChild;
  private readonly dataCbs: ((data: string) => void)[] = [];
  private readonly exitCbs: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  private exited = false;

  constructor(child: SpawnedChild) {
    this.child = child;
    this.pid = child.pid;

    const relay = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const cb of this.dataCbs) cb(text);
    };
    child.stdout?.on("data", relay);
    child.stderr?.on("data", relay);

    child.on("exit", (code, signal) => {
      this.fireExit(code ?? 0, signal ?? null);
    });
    // A spawn error (e.g. ENOENT — binary not found) must NOT crash the session:
    // surface it as a conventional 127 exit so callers restore the tty + report.
    child.on("error", () => {
      this.fireExit(127, null);
    });
  }

  private fireExit(exitCode: number, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    const sigNum = signal ? SIGNAL_NUM[signal] : undefined;
    const e = sigNum !== undefined ? { exitCode, signal: sigNum } : { exitCode };
    for (const cb of this.exitCbs) cb(e);
  }

  write(data: string): void {
    try {
      this.child.stdin?.write(data);
    } catch {
      // stdin closed (child already gone) — drop the keystroke, never throw.
    }
  }

  /** Best-effort: a piped child has no controlling tty to resize. Intentional no-op. */
  resize(_cols: number, _rows: number): void {
    /* no-op — fallback transport cannot propagate SIGWINCH to a pipe */
  }

  onData(listener: (data: string) => void): void {
    this.dataCbs.push(listener);
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCbs.push(listener);
  }

  kill(signal?: string): void {
    try {
      this.child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM");
    } catch {
      // already dead — ignore.
    }
  }
}

/** Lazily require `node:child_process.spawn` (only when the fallback actually spawns). */
function runtimeSpawn(requireFn: RequireFn | undefined): SpawnFn {
  const req = requireFn ?? runtimeRequire();
  if (!req) {
    // No require available AND no injected spawner — return a spawner that yields a
    // child which immediately "errors" so the caller degrades to a 127 exit, never a crash.
    return () => unavailableChild();
  }
  try {
    const cp = req("node:child_process") as { spawn?: SpawnFn };
    if (typeof cp.spawn === "function") return cp.spawn;
  } catch {
    // fall through to the unavailable spawner.
  }
  return () => unavailableChild();
}

/** A child that reports an immediate spawn failure (used when no spawner is reachable). */
function unavailableChild(): SpawnedChild {
  let errorCb: ((err: Error) => void) | undefined;
  return {
    stdin: null,
    stdout: null,
    stderr: null,
    on(event: "exit" | "error", cb: ((...a: never[]) => void) | undefined): void {
      if (event === "error") errorCb = cb as (err: Error) => void;
      // queue the error on the next tick so the caller has registered its handler.
      if (event === "error") {
        queueMicrotask(() => errorCb?.(new Error("child_process unavailable")));
      }
    },
    kill(): boolean {
      return false;
    },
  };
}

/** Wrap a spawner as a child_process-backed PtyBackend (the no-native-addon path). */
function childProcessBackend(spawnFn: SpawnFn): PtyBackend {
  return {
    spawn(opts: PtySpawnOptions): PtyProcess {
      const child = spawnFn(opts.shell, opts.args ?? [], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      // `on`, not `once` — the minimal SpawnedChild contract has no `once`, and untrack is
      // idempotent (deleting an absent key is a no-op), so a repeat call is harmless.
      const untrack = trackChild({
        pid: child.pid,
        label: `pty:${opts.shell}`,
        command: [opts.shell, ...(opts.args ?? [])].join(" "),
      });
      child.on("exit", () => untrack());
      return new ChildProcessPty(child);
    },
  };
}

/* ------------------------------------------------------------------------- *
 * The resolver: node-pty if present, else the child_process fallback
 * ------------------------------------------------------------------------- */

/**
 * Resolve the best available PtyBackend, crash-free:
 *   1. unless `forceChildProcess`, try node-pty (lazy require) → REAL pty backend,
 *   2. otherwise the node:child_process fallback (piped stdio, resize no-op).
 * Both transports are reached through injected seams, so the test exercises each
 * path with a fake require + a fake spawner — no native addon, no real child.
 */
export function resolvePtyBackend(deps?: PtyBackendDeps): PtyBackend {
  const requireFn = deps?.requireFn ?? runtimeRequire();
  if (!deps?.forceChildProcess) {
    const pty = tryLoadNodePty(requireFn);
    if (pty) return nodePtyBackend(pty);
  }
  return childProcessBackend(deps?.spawnFn ?? runtimeSpawn(requireFn));
}
