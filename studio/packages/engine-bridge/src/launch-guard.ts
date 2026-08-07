/**
 * launch-guard.ts — the shared 90% CPU/RAM launch ceiling (CLI-021).
 *
 * The desktop Model Hub refuses to start a heavy model when CPU% OR RAM% is at/above a
 * ceiling (telemetry.ts, default 90%). The CLI `prometheus model pull` needs the SAME guard —
 * so the ceiling + verdict live here (one constant, shared) rather than a forked `90`.
 * The sample uses node:os only (no spawn); the verdict is pure + testable.
 */
import { cpus, freemem, totalmem } from "node:os";

/** CPU% or RAM% at/above this refuses a heavy launch (matches the desktop default). */
export const LAUNCH_CEILING_PCT = 90;

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

/** Sample CPU% (delta over `sleepMs`) + RAM% (OS-reported now). Never throws. */
export async function sampleLaunchGuard(sleepMs = 120): Promise<LaunchGuardSample> {
  const a = cpuTimesTotal();
  await new Promise((r) => setTimeout(r, Math.max(1, sleepMs)));
  const b = cpuTimesTotal();
  const idleD = b.idle - a.idle;
  const totalD = b.total - a.total;
  const cpuPct = totalD > 0 ? Math.max(0, Math.min(100, (1 - idleD / totalD) * 100)) : 0;
  const mem = totalmem();
  const ramPct = mem > 0 ? Math.max(0, Math.min(100, (1 - freemem() / mem) * 100)) : 0;
  return { cpuPct: Math.round(cpuPct), ramPct: Math.round(ramPct) };
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
