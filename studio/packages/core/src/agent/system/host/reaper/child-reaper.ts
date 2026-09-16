/**
 * child-reaper.ts — kill every process this CLI spawned, on every exit path.
 *
 * THE BUG THIS EXISTS FOR. The CLI spawns agent CLIs (`claude`, `codex`, `gemini` — all
 * Node), shells, and sidecars. The swarm spawner uses `detached: true` so it can signal a
 * whole process GROUP and never orphan a grandchild — but `detached` means exactly that the
 * child SURVIVES its parent, and its watchdog timers live in the parent, so they die with it.
 * The desktop app has a thorough `before-quit`; the CLI had no shutdown path at all. Quit the
 * TUI mid-swarm, or Ctrl-C, and every agent kept running forever. A few start/stop cycles and
 * you have twenty orphaned Node processes eating the machine — observed, not hypothetical.
 *
 * DESIGN NOTES, each one load-bearing:
 *
 *  - `process.on("exit")` handlers may only do SYNCHRONOUS work. `process.kill` is sync;
 *    an `await supervisor.stopAll()` in an exit handler silently never runs. That is why
 *    this reaps with raw signals rather than reusing the async supervisor teardown.
 *
 *  - The `exit` event does NOT fire when the process is terminated BY a signal, so SIGINT/
 *    SIGTERM/SIGHUP need their own handlers — otherwise Ctrl-C, the single most common way
 *    to stop a CLI, is precisely the path that leaks.
 *
 *  - Installing a signal handler OVERRIDES node's default disposition: the process no longer
 *    dies on Ctrl-C unless someone makes it. We only force the exit when nothing else is
 *    listening, so the TUI's own handler (terminal restore) still owns shutdown when present.
 *
 *  - `process.kill(-pid)` signals a process group; `-0` and `0` mean "my own group", so a
 *    stale/zero pid would make the CLI kill itself and its shell. pid <= 1 is refused.
 *
 * NOT covered: SIGKILL of the CLI itself, or a power loss — no userspace code runs. For that
 * residue, children are tagged with PROMETHEUS_OWNER_PID and `findOrphans()` can identify
 * them after the fact.
 */
/**
 * The minimal child shape this module needs. Declared locally rather than importing
 * `node:child_process` — that module is engine-bridge's exclusive import (C5), and the
 * rule holds for type-only imports too. Same approach as `pty/backend.ts`'s re-declared
 * PtyBackend contract: a tiny stable surface beats crossing an architectural boundary.
 */
export interface ExitingChild {
  pid?: number | undefined;
  once(event: "exit", listener: () => void): unknown;
}

/** Env var stamped on every tracked child: the pid of the CLI that spawned it. */
export const OWNER_PID_ENV = "PROMETHEUS_OWNER_PID";

export interface TrackedChild {
  pid: number | undefined;
  /** spawned with `detached: true` → signal the whole GROUP so grandchildren die too. */
  group?: boolean;
  /** for diagnostics only (`doctor`, debug logs). */
  label?: string;
  /**
   * The child's command line as spawned — recorded in the durable registry for a human
   * reading it. It is NOT the pid-reuse guard: that is the process start time, which the
   * registry delegate reads from `ps` itself, because a command line is not stable across
   * the exec that a shebang or wrapper script performs.
   */
  command?: string;
}

interface Entry {
  group: boolean;
  label: string;
}

const live = new Map<number, Entry>();
let installed = false;

/**
 * Optional durable mirror (orphan-guard). Kept as a delegate rather than a direct import so
 * this module stays a pure in-process mechanism with no filesystem dependency — the layer
 * that survives SIGKILL is deliberately separable from the layer that handles every other
 * exit, and either can be tested without the other.
 */
export interface RegistryDelegate {
  /** `startedAt` is stamped by the delegate itself — callers cannot supply an identity. */
  add(rec: { pid: number; group: boolean; command: string }): void;
  remove(pid: number): void;
  clear(): void;
}
let registry: RegistryDelegate | null = null;

export function setRegistryDelegate(delegate: RegistryDelegate | null): void {
  registry = delegate;
}

/** Signal numbers for the conventional 128+signo exit status. */
const SIGNO: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

/**
 * Signal one tracked pid. Returns true when a signal was actually delivered.
 * Never throws: a dead child (ESRCH) or one we no longer own (EPERM) is nothing to fix.
 */
function signalOne(pid: number, group: boolean, signal: NodeJS.Signals): boolean {
  // pid 0 and -0 both mean "every process in MY group" — that would kill the CLI and the
  // shell that launched it. pid 1 is init. Neither is ever a child of ours.
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (group) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      /* the group may already be gone, or was never detached — fall through to the pid */
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Track a child so it is killed when this process exits. Returns an untrack function —
 * call it when the child exits normally, so a recycled pid is never signalled later.
 */
export function trackChild(child: TrackedChild): () => void {
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return () => {};
  const group = child.group === true;
  live.set(pid, { group, label: child.label ?? "child" });
  // Mirror to the durable registry so the child is still findable if this process is
  // SIGKILLed. `command` is the pid-reuse guard — without it a later sweep could signal a
  // stranger that inherited the number.
  if (registry) {
    try {
      registry.add({ pid, group, command: child.command ?? "" });
    } catch {
      /* durability is a bonus layer; never let it break a spawn */
    }
  }
  return () => {
    live.delete(pid);
    try {
      registry?.remove(pid);
    } catch {
      /* ignore */
    }
  };
}

/**
 * Track a spawned child, auto-untracking on its own exit.
 *
 * `command` is forwarded, not dropped. It is the durable registry's PID-REUSE GUARD — without
 * it a later sweep can signal a stranger that inherited the number — and this wrapper's opts
 * silently omitted it, so every caller that used the convenience form lost the guard that the
 * direct `trackChild` form has.
 */
export function trackChildProcess(
  child: ExitingChild,
  opts: { group?: boolean; label?: string; command?: string } = {},
): () => void {
  const untrack = trackChild({ pid: child.pid, ...opts });
  child.once("exit", untrack);
  return untrack;
}

/** How many children are currently tracked (diagnostics + tests). */
export function trackedCount(): number {
  return live.size;
}

/** The tracked children, for `doctor` / debugging. */
export function trackedChildren(): { pid: number; group: boolean; label: string }[] {
  return [...live.entries()].map(([pid, e]) => ({ pid, ...e }));
}

/**
 * Signal ONE tracked child by pid — for a caller that needs to stop a SPECIFIC child (e.g. the
 * orchestration resource guard evicting a single runaway `opencode`/`hermes` subprocess under
 * critical RAM pressure) without touching every other child this process happens to have
 * spawned. Returns false for a pid that isn't (or is no longer) tracked. Does NOT untrack the
 * pid itself — that happens naturally via the child's own `exit` handler (`trackChildProcess`),
 * exactly as if the signal had come from the process's own timeout instead of this caller.
 */
export function signalTracked(pid: number, signal: NodeJS.Signals): boolean {
  const entry = live.get(pid);
  if (!entry) return false;
  return signalOne(pid, entry.group, signal);
}

/**
 * Signal every tracked child NOW and forget them. Returns how many were signalled.
 * Synchronous by design so it is usable from a `process.on("exit")` handler.
 */
export function reapNow(signal: NodeJS.Signals = "SIGTERM"): number {
  let killed = 0;
  for (const [pid, entry] of [...live.entries()]) {
    live.delete(pid);
    if (signalOne(pid, entry.group, signal)) killed += 1;
  }
  // The registry exists to describe children NOBODY has dealt with. We just dealt with
  // them, so clearing it also tells the sentinel (which watches the file) to stand down.
  try {
    registry?.clear();
  } catch {
    /* ignore */
  }
  return killed;
}

/**
 * Install the exit + signal handlers. Idempotent; call once from the CLI entry point.
 *
 * `hooks` lets tests drive it without touching the real process. In production every hook
 * defaults to the real `process`.
 */
export function installChildReaper(hooks?: {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  listenerCount?: (event: string) => number;
  exit?: (code: number) => void;
}): void {
  if (installed && !hooks) return;
  installed = true;

  const on = hooks?.on ?? ((e: string, l: (...a: unknown[]) => void) => void process.on(e, l));
  const listenerCount = hooks?.listenerCount ?? ((e: string) => process.listenerCount(e));
  const exit = hooks?.exit ?? ((c: number) => process.exit(c));

  // Normal termination (including `process.exitCode = n; return`).
  on("exit", () => {
    reapNow("SIGTERM");
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    on(sig, () => {
      reapNow("SIGTERM");
      // Registering this handler suppressed node's default "terminate on signal". If we are
      // the ONLY listener, nothing else will stop the process and Ctrl-C would just hang —
      // so exit with the conventional status. When the TUI has also registered one (count > 1),
      // it owns shutdown (it restores the terminal first) and we must not pre-empt it.
      if (listenerCount(sig) <= 1) exit(128 + (SIGNO[sig] ?? 15));
    });
  }
}

/** Reset module state. TESTS ONLY. */
export function __resetForTests(): void {
  live.clear();
  installed = false;
}
