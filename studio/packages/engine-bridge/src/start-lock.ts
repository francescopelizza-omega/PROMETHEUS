/**
 * start-lock.ts — "only one Prometheus surface may be mid-spawn for a given local runner at a
 * time."
 *
 * Both `ensureOllamaRunning` (packages/core/src/ai/ollama-autostart.ts) and the CLI's own
 * onboarding autostart (apps/cli/src/session/onboarding.ts's `probeAndMaybeStart`) run the same
 * check-then-act: probe the port, see nothing listening, then spawn the runner. That is a race
 * the instant two surfaces make the same cold-start decision within the same stretch of
 * milliseconds — two CLI shells opened together, or a CLI shell and the desktop app both waking
 * Ollama for their first prompt. The user-visible cost of losing that race is real: N duplicate
 * `ollama serve` children all fighting over one port, piling on RAM exactly when the machine can
 * least afford it.
 *
 * Reuses pid-lock.ts's atomic pidfile scheme (the same one the idle-shutdown watchdog uses to
 * guarantee only one watchdog per runner). Held only for the duration of ONE start attempt
 * (spawn + that attempt's own retry-probe window), never for the runner's whole lifetime — the
 * caller MUST release it in a `finally`, win or lose.
 */
import { join } from "node:path";

import { type PidLockFs, acquireLock, releaseLock } from "./pid-lock.js";
import { prometheusHome } from "./prom-home.js";

function startLockPath(runnerId: string): string {
  return join(prometheusHome(), "run", `${runnerId}-start.lock`);
}

/**
 * True if THIS process now owns the exclusive right to start `runnerId`'s server. A caller that
 * gets false must NOT spawn — another surface is already deciding this; wait and re-probe
 * instead (see ensureOllamaRunning/probeAndMaybeStart for the ride-along pattern).
 */
export function acquireRunnerStartLock(runnerId: string, fs?: PidLockFs): boolean {
  return acquireLock(startLockPath(runnerId), fs);
}

/** Release the start lock for `runnerId`. Always call this in a `finally` after a successful
 *  `acquireRunnerStartLock`, whether the start attempt itself succeeded or not. */
export function releaseRunnerStartLock(runnerId: string, fs?: PidLockFs): void {
  releaseLock(startLockPath(runnerId), fs);
}
