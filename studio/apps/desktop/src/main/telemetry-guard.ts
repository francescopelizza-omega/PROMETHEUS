// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/telemetry-guard.ts — the PURE launch-guard math (no node:*, no engine-bridge).
 *
 * Split out of telemetry.ts so it is unit-testable with node:test without pulling in
 * the native probes. Given the current CPU% and RAM%, decide whether Prometheus may
 * launch a new HEAVY process (model pull / serve / runner install): allowed only when
 * BOTH sit below the ceiling (default 90%) — so the app never eats the whole machine.
 */
import type { ResourceGuard } from "../shared/ipc-contract.js";

/** The ceiling CPU% and RAM% are each checked against before a heavy launch. */
export const GUARD_THRESHOLD_PCT = 90;

/** Clamp to a sane 0-100 percent (guards against jitter / clock skew). */
export function pct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

/**
 * Pure guard verdict: allow a new heavy launch only when BOTH CPU% and RAM% sit
 * below the ceiling. Exported so it is testable without a live machine.
 */
export function evaluateResourceGuard(
  cpuPct: number,
  ramPct: number,
  threshold = GUARD_THRESHOLD_PCT,
): ResourceGuard {
  const tripped: ("cpu" | "ram")[] = [];
  if (cpuPct >= threshold) tripped.push("cpu");
  if (ramPct >= threshold) tripped.push("ram");
  const allow = tripped.length === 0;
  const guard: ResourceGuard = {
    allow,
    thresholdPct: threshold,
    cpuPct: pct(cpuPct),
    ramPct: pct(ramPct),
    tripped,
  };
  if (!allow) {
    const parts = tripped.map((t) => (t === "cpu" ? `CPU ${pct(cpuPct)}%` : `RAM ${pct(ramPct)}%`));
    guard.reason = `System under heavy load (${parts.join(" · ")} ≥ ${threshold}%). Free resources, then retry — Prometheus won't launch work that would saturate the machine.`;
  }
  return guard;
}
