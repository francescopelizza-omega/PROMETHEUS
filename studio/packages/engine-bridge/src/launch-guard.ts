// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * launch-guard.ts — the shared 90% CPU/RAM launch ceiling (CLI-021).
 *
 * The desktop Model Hub refuses to start a heavy model when CPU% OR RAM% is at/above a
 * ceiling (telemetry.ts, default 90%). The CLI `prometheus model pull` needs the SAME guard —
 * so the ceiling + verdict live here (one constant, shared) rather than a forked `90`.
 * The sample uses node:os only (no spawn); the verdict is pure + testable.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";

/** CPU% or RAM% at/above this refuses a heavy launch (matches the desktop default). */
export const LAUNCH_CEILING_PCT = 90;

/**
 * RAM% at/above this means the machine is not just "too loaded to start something new" but
 * actively at risk of a black-screen freeze RIGHT NOW — the active-eviction ceiling (higher than
 * `LAUNCH_CEILING_PCT`, deliberately: an already-running server that is actively serving a user
 * gets evicted only when there is no other honest reading of the number, never on the same
 * threshold that merely delays a NEW launch).
 */
export const CRITICAL_RAM_CEILING_PCT = 95;

export interface LaunchGuardSample {
  cpuPct: number;
  ramPct: number;
}

function cpuTimesTotal(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

/* ── AVAILABLE memory, not raw free ───────────────────────────────────────────
 * `os.freemem()` counts only wholly-free pages. It excludes reclaimable cache,
 * so on macOS and Linux it wildly overstates "used" — the desktop's own
 * `main/telemetry.ts::readMemory` says exactly this and reads the OS's real
 * "available" figure instead. This guard MUST agree with that reading: it is
 * the number the 90% launch ceiling and the 95% eviction ceiling are compared
 * against, and a guard that overstates pressure refuses launches on a healthy
 * machine and evicts a model server the user is actively using.
 *
 * Measured on the maintainer's 64 GB Apple Silicon box while idle:
 *   freemem()            -> 30.59 GB  =>  ramPct 52%
 *   real available       -> 44.66 GB  =>  ramPct 30%
 * A 22-point overstatement at rest, and it widens as the page cache fills.
 *
 * This is SYNCHRONOUS because `ramPctNow` is synchronous by contract
 * (`ServeSupervisor.start()` returns a `ServeRow`, not a Promise). On darwin
 * that means one `vm_stat` fork per read, so results are cached for
 * `AVAIL_TTL_MS` — a poll loop calling this every tick must never become a
 * fork storm, which is the exact failure mode this repo keeps hitting.
 *
 * `vm_stat` is spawned by ABSOLUTE path: a packaged Electron main process
 * inherits a minimal PATH, and a bare "vm_stat" silently fails to resolve.
 * Any failure falls back to `freemem()` — conservative (reads higher
 * pressure), never throws, and never leaves the ceiling unenforced. */
const AVAIL_TTL_MS = 250;
let availCache: { at: number; bytes: number } | null = null;

function readAvailableBytesUncached(total: number): number {
  const fallback = freemem();
  try {
    if (process.platform === "linux") {
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(readFileSync("/proc/meminfo", "utf8"));
      return m ? Math.min(total, Number(m[1]) * 1024) : fallback;
    }
    if (process.platform === "darwin") {
      const out = execFileSync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 2000 });
      const ps = /page size of (\d+) bytes/.exec(out);
      const pageSize = ps ? Number(ps[1]) : 4096;
      const grab = (label: string): number => {
        const m = new RegExp(`${label}:\\s+(\\d+)\\.`).exec(out);
        return m ? Number(m[1]) : 0;
      };
      const pages =
        grab("Pages free") +
        grab("Pages inactive") +
        grab("Pages speculative") +
        grab("Pages purgeable");
      return pages > 0 ? Math.min(total, pages * pageSize) : fallback;
    }
  } catch {
    /* fall through to freemem() — see the doc comment on why that is the safe direction */
  }
  return fallback;
}

/** Bytes of memory actually available to allocate, TTL-cached. Never throws. */
function availableBytes(total: number): number {
  const now = Date.now();
  if (availCache && now - availCache.at < AVAIL_TTL_MS) return availCache.bytes;
  const bytes = readAvailableBytesUncached(total);
  availCache = { at: now, bytes };
  return bytes;
}

/** RAM% used, from AVAILABLE memory. Clamped to [0,100]. Never throws. */
function ramPctFromAvailable(): number {
  const total = totalmem();
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - availableBytes(total) / total) * 100));
}

/** Sample CPU% (delta over `sleepMs`) + RAM% (OS-reported now). Never throws. */
export async function sampleLaunchGuard(sleepMs = 120): Promise<LaunchGuardSample> {
  const a = cpuTimesTotal();
  await new Promise((r) => setTimeout(r, Math.max(1, sleepMs)));
  const b = cpuTimesTotal();
  const idleD = b.idle - a.idle;
  const totalD = b.total - a.total;
  const cpuPct = totalD > 0 ? Math.max(0, Math.min(100, (1 - idleD / totalD) * 100)) : 0;
  return { cpuPct: Math.round(cpuPct), ramPct: Math.round(ramPctFromAvailable()) };
}

/** Pure verdict: refuse (naming the saturated resource) when CPU% OR RAM% ≥ ceiling. */
export function launchGuardVerdict(
  sample: LaunchGuardSample,
  ceiling: number = LAUNCH_CEILING_PCT,
): { ok: boolean; reason?: string } {
  if (sample.cpuPct >= ceiling) {
    return { ok: false, reason: `CPU at ${sample.cpuPct}% ≥ ${ceiling}% ceiling` };
  }
  if (sample.ramPct >= ceiling) {
    return { ok: false, reason: `RAM at ${sample.ramPct}% ≥ ${ceiling}% ceiling` };
  }
  return { ok: true };
}

/**
 * RAM% right now — the OS's reading, no artificial delay. `sampleLaunchGuard` needs a real sleep
 * to get a CPU delta, which is fine for a `/model pull` confirmation but too slow for a launch
 * path that must stay SYNCHRONOUS (ServeSupervisor.start() returns a `ServeRow`, not a Promise,
 * so it can never `await` a guard). RAM is also the more direct signal for "about to freeze the
 * machine" — a launch that pushes RAM past the ceiling is the exact mechanism a black-screen
 * freeze traces back to; a CPU spike alone degrades performance without risking that collapse.
 */
export function ramPctNow(): number {
  return ramPctFromAvailable();
}

/** Pure verdict over RAM alone, for a synchronous caller — see `ramPctNow`'s doc for why. */
export function ramCeilingVerdict(
  ramPct: number,
  ceiling: number = LAUNCH_CEILING_PCT,
): { ok: boolean; reason?: string } {
  if (ramPct >= ceiling) {
    return { ok: false, reason: `RAM at ${Math.round(ramPct)}% ≥ ${ceiling}% ceiling` };
  }
  return { ok: true };
}

/**
 * The next consecutive-critical-poll count, given the previous streak and this poll's RAM
 * reading. Shared by every active-eviction monitor (the ollama idle/critical watchdog AND the
 * desktop's ServeSupervisor) so "never evict on a single noisy spike" is ONE tested rule, not a
 * second hand-rolled copy: any non-critical reading resets to 0; a critical one increments.
 */
export function nextCriticalStreak(
  previousStreak: number,
  ramPct: number,
  ceiling: number = CRITICAL_RAM_CEILING_PCT,
): number {
  return ramCeilingVerdict(ramPct, ceiling).ok ? 0 : previousStreak + 1;
}

/** Consecutive critical polls required before evicting — enough SUSTAINED pressure (paired with
 *  each caller's own poll interval) that a momentary spike from something unrelated never costs
 *  the user their model server. */
export const CRITICAL_POLLS_REQUIRED = 2;
