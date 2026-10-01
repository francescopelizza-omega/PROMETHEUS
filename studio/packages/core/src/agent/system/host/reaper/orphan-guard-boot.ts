// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orphan-guard-boot.ts — start the orphan defences for this CLI run.
 *
 * Separated from `orphan-guard.ts` because that module is pure logic (testable with fakes,
 * no spawning) while this one is the IO edge: it shells out for `ps`, spawns the sentinel,
 * and touches the real process table. One import site, `bin.ts`.
 *
 * Order matters. The SWEEP runs before anything is spawned, so a fleet left by a previous
 * SIGKILLed run is cleaned at the start of the next launch — which is exactly the shape of
 * the reported symptom: orphans accumulating across several start/stop cycles.
 */
import { createRequire } from "node:module";

import { type RegistryDelegate, setRegistryDelegate } from "./child-reaper.js";
import {
  SENTINEL_SCRIPT,
  type SweepResult,
  closeRegistry,
  forgetChild,
  openRegistry,
  recordChild,
  sweepOrphans,
} from "./orphan-guard.js";

// node:child_process is engine-bridge's exclusive static import (C5); a runtime require is
// the sanctioned escape hatch, as in orchestration/spawn-capture.ts.
const nodeRequire = createRequire(import.meta.url);

type SpawnLike = (
  cmd: string,
  args: readonly string[],
  opts: Record<string, unknown>,
) => { pid?: number; unref?: () => void };

type ExecFileSyncLike = (
  cmd: string,
  args: readonly string[],
  opts: Record<string, unknown>,
) => string;

/** The current command line of a pid, or null. Uses `ps`; never throws. */
export function psCommand(pid: number): string | null {
  try {
    const execFileSync = (nodeRequire("node:child_process") as { execFileSync: ExecFileSyncLike })
      .execFileSync;
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = String(out).trim();
    return line.length > 0 ? line : null;
  } catch {
    return null; // no such process, or ps unavailable
  }
}

/**
 * The pid's START TIME (`ps -o lstart=`), or null. This is the pid-reuse identity.
 *
 * Deliberately NOT the command line: a shebang or wrapper child's command changes when the
 * kernel finishes the exec (`python3 -c …` → `/opt/homebrew/…/Python -c …`), so comparing
 * commands skipped exactly the `pip install` orphan Phase 4 exists to prevent. Start time
 * is fixed at fork, so it is immune to that race.
 */
export function psStart(pid: number): string | null {
  try {
    const execFileSync = (nodeRequire("node:child_process") as { execFileSync: ExecFileSyncLike })
      .execFileSync;
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      // `lstart` is a HUMAN-FORMATTED date, so it is locale-dependent: under it_IT the same
      // process reads `lun 10 ago 16:25:36 2026` and under C it reads `Mon Aug 10 16:25:36
      // 2026`. The sentinel is a detached `sh` with a sanitized environment, so it saw the C
      // form while this process saw the user's — a guaranteed mismatch, and therefore a
      // guaranteed skipped kill, on any machine not running in English. Both readers pin the
      // locale so the string is comparable at all.
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    return normalizeStart(String(out));
  } catch {
    return null;
  }
}

/** Collapse runs of whitespace and trim — `ps` pads its columns, and the padding varies. */
export function normalizeStart(raw: string): string | null {
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > 0 ? line : null;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, group: boolean, sig: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (group) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      /* fall through to the bare pid */
    }
  }
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

let sentinelPid: number | undefined;
let registryFilePath = "";

/**
 * The registry delegate handed to child-reaper.
 *
 * The sentinel is started LAZILY, on the first tracked child, for two reasons. It must not
 * start earlier: the sentinel stands down when the registry file is absent, and the file is
 * only written once there is something to record — so a sentinel spawned at boot would
 * exit immediately and the run would be unguarded (an earlier version did exactly that, and
 * only appeared to work because the first spawn happened to win the race). And it should not
 * start earlier: `prometheus --version` has no children, so it has nothing to guard.
 */
const delegate: RegistryDelegate = {
  add: (rec) => {
    // The start time is stamped HERE rather than by the caller, on purpose. When each call
    // site supplied its own identity string they got it wrong in different ways — one
    // passed `argv.join(" ")`, which never matches `ps` for a wrapper script. One place
    // that reads it means one place that can be wrong.
    const startedAt = psStart(rec.pid);
    // No start time means no reuse guard, and a post-mortem kill without one could signal a
    // stranger's process. Skip the record instead: leaking a child is recoverable, killing
    // an unrelated pid is not.
    if (!startedAt) return;
    recordChild({ ...rec, startedAt }); // writes the registry FIRST …
    ensureSentinel(); // … so the sentinel finds it and stays up
  },
  remove: (pid) => forgetChild(pid),
  clear: () => closeRegistry(),
};

function ensureSentinel(): void {
  if (sentinelPid !== undefined || !registryFilePath) return;
  sentinelPid = startSentinel(registryFilePath);
}

/**
 * Spawn the sentinel: one detached `sh` that outlives us and cleans up if we are killed
 * without warning. `unref` so it never holds the event loop open, `detached` so it is not
 * in our process group — being killed by the same signal that killed us would defeat it.
 */
function startSentinel(registryFile: string): number | undefined {
  try {
    const spawn = (nodeRequire("node:child_process") as { spawn: SpawnLike }).spawn;
    const child = spawn(
      "/bin/sh",
      ["-c", SENTINEL_SCRIPT, "prometheus-sentinel", String(process.pid), registryFile],
      { detached: true, stdio: "ignore" },
    );
    child.unref?.();
    return child.pid;
  } catch {
    return undefined; // no sentinel is survivable — the other two layers still apply
  }
}

/** Kill our own sentinel (normal shutdown — the reaper already handled the children). */
export function stopSentinel(): void {
  if (sentinelPid === undefined) return;
  signal(sentinelPid, false, "SIGTERM");
  sentinelPid = undefined;
}

export interface GuardBootResult {
  sweep: SweepResult;
  registryFile: string;
  sentinelPid: number | undefined;
}

/**
 * Boot all three layers. Fail-soft throughout: this is protection, and protection that can
 * crash the thing it protects is a net loss.
 */
export function bootOrphanGuard(home: string): GuardBootResult {
  let sweep: SweepResult = { adopted: 0, killed: [], skippedReused: 0 };
  try {
    // BEFORE we register anything of our own: adopt the leftovers of dead runs.
    sweep = sweepOrphans(home, { ps: psStart, alive: isAlive, kill: signal });
  } catch {
    /* a failed sweep must not stop the CLI from starting */
  }

  try {
    registryFilePath = openRegistry(home);
    setRegistryDelegate(delegate);
    // No sentinel yet — see `delegate` above: it starts with the first tracked child.
  } catch {
    setRegistryDelegate(null);
  }
  return { sweep, registryFile: registryFilePath, sentinelPid };
}
