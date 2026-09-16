/**
 * orchestration/resource-guard.ts — ACTIVE EVICTION for one-shot orchestration agent-CLI
 * subprocesses (`opencode`, `hermes`), at the same cadence and ceiling as the protection
 * `ensureOllamaRunning`/`ServeSupervisor` give the local model runners: under SUSTAINED critical
 * RAM, stop what Prometheus itself spawned rather than let the machine freeze.
 *
 * These recipe invocations are already bounded by their own wall-clock + idle timeouts
 * (spawn-capture.ts's `killGroup`) — this exists for the window BEFORE those timeouts fire, when
 * the machine is ALREADY in danger. `backends.ts`'s `cliInvoke` separately refuses a NEW launch
 * under the same pressure for every recipe alike (not just these two); this is the narrower,
 * more disruptive "stop something ALREADY running" tool, deliberately scoped to just opencode
 * and hermes rather than every vendor CLI this backend can spawn.
 */
import {
  CRITICAL_POLLS_REQUIRED,
  CRITICAL_RAM_CEILING_PCT,
  nextCriticalStreak,
  ramPctNow,
  recordEvictionEvent,
} from "@prometheus/engine-bridge";

import { signalTracked, trackedChildren } from "../child-reaper.js";

/*
 * 2 s, not 30 s — matching POLL_MS in engine-bridge/ollama-watchdog-entry.ts and
 * ServeSupervisor's `criticalCheckIntervalMs`.
 *
 * With CRITICAL_POLLS_REQUIRED = 2, a 30 s poll cannot evict for 60 s (90 s if pressure starts
 * just after a tick) — against a collapse this repo has measured at TWO SECONDS. At that latency
 * the docstring's claim of "the same protection ServeSupervisor already gives" was false by 15x.
 *
 * Idle sessions pay nothing: the no-tracked-children early return happens BEFORE any RAM sample,
 * so `vm_stat` is only forked while an opencode/hermes child is actually live — and `ramPctNow`
 * caches for 250 ms, so co-resident monitors on one tick share a single read.
 *
 * Overlapping ticks are safe at this cadence (they were impossible at 30 s): the eviction body
 * awaits KILL_GRACE_MS, but `streakRef.value` is reset to 0 BEFORE that await, so a tick that
 * lands mid-eviction increments 0 -> 1 and returns without firing.
 */
const POLL_MS = 2_000;
const KILL_GRACE_MS = 3_000;
/** Only these — see the module docstring for why this stays narrower than "every recipe". */
const GUARDED_BINS = new Set(["opencode", "hermes"]);

/** `spawn-capture.ts` tracks every recipe child as `agent:<bin>` — extract `<bin>` and confirm
 *  it is one this guard protects. Returns undefined for anything else (untouched). */
function guardedBin(label: string): string | undefined {
  const bin = label.startsWith("agent:") ? label.slice("agent:".length) : label;
  return GUARDED_BINS.has(bin) ? bin : undefined;
}

/** True if `pid` still exists (ESRCH ⇒ dead). Same shape as every other liveness check in this
 *  codebase (fleet/heartbeat.ts's `pidAlive`, engine-bridge's `pidIsAlive`) — kept local rather
 *  than imported so this file's dependency graph stays exactly what it needs. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ResourceGuardDeps {
  trackedChildrenFn?: typeof trackedChildren;
  signalTrackedFn?: typeof signalTracked;
  ramSampleFn?: () => number;
  recordEvictionFn?: typeof recordEvictionEvent;
  pidAliveFn?: (pid: number) => boolean;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * One check cycle: sample RAM ONLY while at least one guarded child is tracked (a session that
 * never touches `/demos` must pay nothing for this), advance the SUSTAINED-critical streak, and
 * — once confirmed sustained, never on a single spike — SIGTERM every guarded child, then
 * SIGKILL whichever are still alive after a grace window. `streakRef` is caller-owned so a test
 * can run this function repeatedly without a real 30s interval.
 */
export async function checkOrchestrationResourcePressure(
  streakRef: { value: number },
  deps: ResourceGuardDeps = {},
): Promise<void> {
  const trackedChildrenFn = deps.trackedChildrenFn ?? trackedChildren;
  const children = trackedChildrenFn()
    .map((c) => ({ ...c, bin: guardedBin(c.label) }))
    .filter((c): c is { pid: number; group: boolean; label: string; bin: string } => c.bin !== undefined);
  if (children.length === 0) {
    streakRef.value = 0; // nothing to protect right now — an old streak must not carry over
    return;
  }

  const ramSampleFn = deps.ramSampleFn ?? ramPctNow;
  const ramPct = ramSampleFn();
  streakRef.value = nextCriticalStreak(streakRef.value, ramPct, CRITICAL_RAM_CEILING_PCT);
  if (streakRef.value < CRITICAL_POLLS_REQUIRED) return;
  streakRef.value = 0; // reset regardless of outcome — never re-fire every tick in a row

  const signalTrackedFn = deps.signalTrackedFn ?? signalTracked;
  const recordEvictionFn = deps.recordEvictionFn ?? recordEvictionEvent;
  const pidAliveFn = deps.pidAliveFn ?? pidAlive;
  const sleepFn = deps.sleepFn ?? sleep;
  const reason = `RAM at ${ramPct}% ≥ ${CRITICAL_RAM_CEILING_PCT}% for ${CRITICAL_POLLS_REQUIRED} consecutive checks — stopped to prevent a machine-wide freeze`;

  for (const child of children) {
    signalTrackedFn(child.pid, "SIGTERM");
    recordEvictionFn({
      runnerId: child.bin,
      name: child.bin,
      pid: child.pid,
      ramPct,
      ceiling: CRITICAL_RAM_CEILING_PCT,
      reason,
    });
  }
  await sleepFn(KILL_GRACE_MS);
  for (const child of children) {
    if (pidAliveFn(child.pid)) signalTrackedFn(child.pid, "SIGKILL");
  }
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;

/**
 * Start the periodic check. Call ONCE from the CLI entry point, alongside
 * `installChildReaper()` — idempotent, a second call is a no-op. Unref'd: never keeps the
 * process alive on its own, matching every other background poll in this codebase (the fleet
 * ticker, the idle-shutdown watchdog).
 */
export function startOrchestrationResourceGuard(deps: ResourceGuardDeps = {}): void {
  if (intervalHandle) return;
  const streakRef = { value: 0 };
  intervalHandle = setInterval(() => {
    void checkOrchestrationResourcePressure(streakRef, deps);
  }, POLL_MS);
  intervalHandle.unref?.();
}

/** TESTS ONLY. */
export function __resetOrchestrationResourceGuardForTests(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = undefined;
}
