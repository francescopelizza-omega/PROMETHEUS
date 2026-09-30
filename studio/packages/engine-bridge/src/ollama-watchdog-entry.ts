#!/usr/bin/env node
/**
 * ollama-watchdog-entry.ts — the standalone idle-shutdown loop for a Prometheus-managed local
 * runner (Ollama, LM Studio, …). Run as its OWN detached process (never imported), spawned by
 * `spawnWatchdogIfNeeded` in ollama-watchdog.ts right after Prometheus starts the runner, from
 * ANY surface (CLI, desktop, VS Code) — see that file's docstring for why it must be a
 * separate process rather than a timer living inside one session.
 *
 * DELIBERATELY dependency-free of `@prometheus/core` (only `node:*` + this package's own
 * `listenersOnPort`/`signalPid`/`execCapture`): `@prometheus/core` depends on
 * `@prometheus/engine-bridge`, never the other way, and a module that gets `node <path>`-spawned
 * directly (not imported through a bundler) needs its own module graph to resolve cleanly
 * regardless of which surface's build produced the caller.
 *
 * Usage: `node ollama-watchdog-entry.js --idle-ms 900000 [--port 11434]
 *         [--process-match ollama] [--runner-id ollama] [--display-name Ollama]
 *         [--stop-cmd '["lms","server","stop"]']`
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { recordEvictionEvent } from "./eviction-log.js";
import {
  CRITICAL_POLLS_REQUIRED,
  CRITICAL_RAM_CEILING_PCT,
  nextCriticalStreak,
  ramPctNow,
} from "./launch-guard.js";
import { listenersOnPort, signalPid } from "./model-server.js";
import { acquireLock, releaseLock } from "./pid-lock.js";
import { prometheusHome } from "./prom-home.js";
import { execCapture } from "./system-probe.js";

/*
 * 2 s, not 30 s. The documented failure on this machine is llama-server going 8.7 GB -> 17 GB
 * in TWO SECONDS. With CRITICAL_POLLS_REQUIRED = 2, a 30 s poll cannot act for 60-90 s — by
 * which point the display has already starved and the only exit is a hard power-off. The shell
 * watchdog (handoffs/ram-guard.sh) polls at 2 s for exactly this reason; the TypeScript guards
 * are the ones that actually ship, and they were the slow ones.
 *
 * TWO different cadences, because the two probes cost wildly different amounts:
 *
 *   - RAM (`ramPctNow`) runs on EVERY 2 s tick. One `vm_stat` fork, ~2 ms, and the reading is
 *     cached for 250 ms so several monitors on one tick share a single read. This is the cadence
 *     the 8.7 GB -> 17 GB failure actually needs.
 *   - LIVENESS (`listenersOnPort`) runs on the first tick and then only every
 *     `PORT_PROBE_EVERY`th (~30 s), plus immediately whenever RAM is at or above the ceiling.
 *     It forks `lsof -nP -iTCP:<port> -sTCP:LISTEN` with a 4 s timeout and NO cache, and `lsof`
 *     enumerates every process's open descriptors — routinely 100 ms-2 s on a loaded macOS box,
 *     three orders of magnitude more than the vm_stat fork, in a repo whose documented lockup
 *     mechanism is fork storms. Running it at 2 s was an unaccounted cost in the note that used
 *     to sit here, which budgeted for `vm_stat` alone.
 *
 * ~30 s liveness latency is what the pre-2 s version already had, and the probe is forced fresh
 * the moment a critical streak can start — so the pid written into the eviction log and the
 * "runner is gone, stand down" exit are both current when eviction actually fires.
 *
 * Keeping CRITICAL_POLLS_REQUIRED at 2 still means a lone spike never evicts — it just costs
 * 4 s to confirm instead of 60 s.
 */
const POLL_MS = 2_000;
/** Liveness probe cadence, in ticks (15 × 2 s ≈ 30 s) — see the note above. */
const PORT_PROBE_EVERY = 15;
const KILL_GRACE_MS = 3_000;

export { CRITICAL_POLLS_REQUIRED, nextCriticalStreak };

// Re-exported AND imported: callers import it from here, and this module calls it itself. A
// second copy of the rule is how the start lock, the eviction log and model-activity.json came
// to disagree in the first place.
export { prometheusHome };

export function activityPath(home: string): string {
  return join(home, "state", "model-activity.json");
}

/** Per-runner lock — each managed runner (ollama, lmstudio, …) gets its OWN pidfile so two
 *  different runners' watchdogs never contend for the same lock (a shared path here would let
 *  the second-started runner's watchdog silently no-op forever, exactly the failure this
 *  mechanism exists to prevent). Mirrors start-lock.ts's own `${runnerId}-start.lock` convention. */
export function pidfilePath(home: string, runnerId: string): string {
  return join(home, "run", `${runnerId}-watchdog.pid`);
}

/** Fail-soft: a missing/corrupt activity file reads as "just started now", never "idle forever". */
export function readLastActiveAt(home: string): number {
  try {
    const raw = JSON.parse(readFileSync(activityPath(home), "utf8")) as unknown;
    const at =
      raw && typeof raw === "object" ? (raw as { lastActiveAt?: unknown }).lastActiveAt : undefined;
    return typeof at === "number" && Number.isFinite(at) ? at : Date.now();
  } catch {
    return Date.now();
  }
}

/** A fresh watchdog counts as activity too — see the module docstring's grace-period note. */
export function touchActivity(home: string): void {
  try {
    const file = activityPath(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ lastActiveAt: Date.now() })}\n`);
  } catch {
    /* best-effort */
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The SIGTERM→SIGKILL escalation, for a runner with no dedicated `stop` command — correct only
 * when the target IS a standalone daemon (Ollama's `ollama serve`), never when a server runs
 * inside a larger application process (see `stopViaCommand`'s doc for why that distinction is
 * load-bearing, not cosmetic).
 */
export async function stopOllama(processMatch: string, port: number): Promise<void> {
  const first = await listenersOnPort(port);
  const targets = first.processes.filter(
    (p) => p.command === processMatch || p.command.includes(processMatch),
  );
  if (targets.length === 0) return;
  for (const p of targets) signalPid(p.pid, "SIGTERM");
  await sleep(KILL_GRACE_MS);
  const after = await listenersOnPort(port);
  for (const p of after.processes) {
    if (p.command === processMatch || p.command.includes(processMatch)) {
      signalPid(p.pid, "SIGKILL");
    }
  }
}

/**
 * Stop a runner via its OWN graceful CLI command (e.g. `lms server stop`) instead of signalling
 * a process — ALWAYS preferred when available. Verified against a real LM Studio install
 * (2026-09): the app's server runs INSIDE its main application process, not as a separate
 * daemon — a raw SIGTERM/SIGKILL on "whatever is listening on the port" would quit the WHOLE
 * app, while `lms server stop` frees the port and leaves the app running. Fail-soft: a stop
 * command that errors or times out is logged nowhere special here (this process exits either
 * way) — the NEXT poll cycle of some future watchdog, or the user's own `ps`, is the fallback
 * if the vendor tool itself is broken; this is not the place to invent a second escalation path
 * that could disagree with the vendor's own tool about whether it worked.
 */
export async function stopViaCommand(cmd: readonly string[]): Promise<void> {
  const [bin, ...args] = cmd;
  if (!bin) return;
  await execCapture(bin, args, { timeoutMs: 15_000 });
}

/** Fail-soft: a missing/malformed `--stop-cmd` value is treated as "no stop command" — falls
 *  back to signal-based stop rather than crashing a detached background process over a flag. */
export function parseStopCmd(raw: string | undefined): readonly string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s) => typeof s === "string")) {
      return parsed as string[];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stop the runner using whichever mechanism is correct for it: the vendor's own graceful
 * command when one is known (`stopCmd`), else the port-based signal escalation. See
 * `LocalRunnerSpec.stop`'s doc (packages/core/src/ai/local-runners.ts) for why these are NOT
 * interchangeable — signalling a process that IS a whole vendor application, rather than its
 * own lightweight daemon, quits far more than "the server".
 */
export async function stopRunner(
  processMatch: string,
  port: number,
  stopCmd: readonly string[] | undefined,
): Promise<void> {
  if (stopCmd) {
    await stopViaCommand(stopCmd);
    return;
  }
  await stopOllama(processMatch, port);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? (args[i + 1] as string) : fallback;
  };
  const idleMs = Number(flag("idle-ms", String(15 * 60 * 1000)));
  const port = Number(flag("port", "11434"));
  const processMatch = flag("process-match", "ollama");
  // Default to processMatch for both — correct for Ollama (its processMatch IS its id/name);
  // every other runner's real spawnWatchdogIfNeeded call passes these explicitly.
  const runnerId = flag("runner-id", processMatch);
  const displayName = flag("display-name", processMatch);
  const stopCmd = parseStopCmd(flag("stop-cmd", ""));
  const home = prometheusHome();

  if (!acquireLock(pidfilePath(home, runnerId))) return; // a live watchdog already owns this runner.
  touchActivity(home); // a fresh start is evidence of imminent use, not 20 idle minutes already.

  let criticalStreak = 0;
  /** the last liveness probe's result, reused between the ~30 s port probes. */
  let lastTarget: Awaited<ReturnType<typeof listenersOnPort>>["processes"][number] | undefined;
  let tick = -1;
  try {
    for (;;) {
      await sleep(POLL_MS);
      tick += 1;
      // Another watchdog reclaimed the lock (shouldn't happen given acquireLock's atomicity,
      // but a hand-edited pidfile is a real possibility) — step aside rather than fight it.
      let owned = false;
      try {
        owned = Number(readFileSync(pidfilePath(home, runnerId), "utf8").trim()) === process.pid;
      } catch {
        owned = false;
      }
      if (!owned) return;

      // RAM first: it is the cheap, cached probe, and its value decides whether this tick also
      // needs a fresh (expensive) port probe. `ramPctNow` is read once and reused below.
      const ramPct = ramPctNow();
      // Probe the port on the first tick, every ~30 s after that, and ALWAYS while RAM is at or
      // above the ceiling — so a streak that is about to evict is deciding on a current pid.
      // The probe is never skipped merely because RAM looks healthy: `!target` below is this
      // loop's only liveness exit, and without it a watchdog whose runner has died would spin
      // forever holding `<runnerId>-watchdog.pid` and block a later respawn from taking it.
      const mustProbe =
        tick % PORT_PROBE_EVERY === 0 ||
        lastTarget === undefined ||
        ramPct >= CRITICAL_RAM_CEILING_PCT;
      if (mustProbe) {
        const listening = await listenersOnPort(port);
        // With a dedicated stop command, PORT PRESENCE is the liveness signal — the process name
        // is not reliable across a vendor's own rebrands (LM Studio's app reports as "Bionic" on
        // a real, current install, not "LM Studio"; see local-runners.ts's processMatch doc).
        // Without one (Ollama), keep the name-match: it is how the SIGTERM/SIGKILL target below
        // is chosen, so "still up" must agree with "what we'd actually signal".
        lastTarget = stopCmd
          ? listening.processes[0]
          : listening.processes.find(
              (p) => p.command === processMatch || p.command.includes(processMatch),
            );
      }
      const target = lastTarget;
      if (!target) return; // nothing left to manage — a manual stop or a crash beat us to it.

      // ACTIVE EVICTION: unlike idle-shutdown below, this fires regardless of whether the runner
      // is in active use — a machine sustained at critical RAM is the exact mechanism a
      // black-screen freeze traces back to, and an in-use server is not exempt from that. Two
      // consecutive critical polls (~60s) are required so one noisy sample never costs the user
      // their model server; see nextCriticalStreak's doc. (`ramPct` was read above, before the
      // liveness probe, because it decides whether that probe runs this tick.)
      criticalStreak = nextCriticalStreak(criticalStreak, ramPct, CRITICAL_RAM_CEILING_PCT);
      if (criticalStreak >= CRITICAL_POLLS_REQUIRED) {
        // The NOTICE is best-effort; the KILL is not. `recordEvictionEvent` writes to disk and
        // can throw (EACCES, ENOSPC, an unusable lock path), and this process was spawned
        // detached with `stdio: "ignore"` — an escaping error would abort the eviction before
        // `stopRunner` and take the watchdog down leaving no trace anywhere. The desktop's
        // ServeSupervisor already guards its identical call for exactly this reason.
        try {
          recordEvictionEvent(
            {
              runnerId,
              name: displayName,
              pid: target.pid,
              ramPct,
              ceiling: CRITICAL_RAM_CEILING_PCT,
              reason: `RAM at ${ramPct}% ≥ ${CRITICAL_RAM_CEILING_PCT}% for ${CRITICAL_POLLS_REQUIRED} consecutive checks — stopped to prevent a machine-wide freeze`,
            },
            home,
          );
        } catch {
          /* a lost notice must never cost the eviction */
        }
        await stopRunner(processMatch, port, stopCmd);
        return;
      }

      const idleFor = Date.now() - readLastActiveAt(home);
      if (idleFor >= idleMs) {
        await stopRunner(processMatch, port, stopCmd);
        return;
      }
    }
  } finally {
    releaseLock(pidfilePath(home, runnerId));
  }
}

// Run only when executed directly (`node ollama-watchdog-entry.js …`), never on a bare
// `import` — this lets a test import the module to exercise its helpers without spawning a
// real poll loop that touches the pidfile/activity file/port.
//
// `pathToFileURL`, NOT a `file://` template. `import.meta.url` is a URL, so it percent-encodes
// every character a path may legally contain and a URL may not — and the packaged macOS path is
// ".../Prometheus Studio.app/Contents/...", whose space arrives as %20. Comparing that against
// a raw `process.argv[1]` is false for exactly the install layout that ships, which meant the
// watchdog process would start, match nothing, and exit 0 silently — no poll loop, no idle
// shutdown, no critical-RAM eviction, and no error anywhere to say so.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
