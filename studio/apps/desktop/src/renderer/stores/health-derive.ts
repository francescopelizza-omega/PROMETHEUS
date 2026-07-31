/**
 * renderer/stores/health-derive.ts — the PURE health→pill derivation (§5).
 *
 * Extracted from engine.ts so it carries ZERO dependencies (no zustand, no react,
 * no DOM) and can be unit-tested with node:test directly. engine.ts re-exports it
 * and the Zustand slice is a thin shell around it. Keeping the decision logic pure
 * is also the C5-aligned posture: a fail-closed bias toward NOT "ready" is a rule
 * worth pinning under test, independent of the store framework.
 */

import type { HealthResult } from "../../shared/ipc-contract.js";

/** The title-bar pill state derived from a HealthResult (08 §4.2). */
export type HealthPill = "ready" | "degraded" | "down" | "unknown";

/**
 * Derive the pill colour from a health probe (PURE — no I/O, fully testable):
 *   - down     : the engine/contract is unusable (no version OR contract broke).
 *   - degraded : engine works but nemesis is missing → installs fail-closed (amber).
 *   - ready    : engine + contract + scanner all good (green).
 *   - unknown  : no probe yet (null).
 * Fail-closed bias: any doubt resolves AWAY from "ready" (C5 in spirit).
 */
export function deriveHealthPill(health: HealthResult | null): HealthPill {
  if (health === null) return "unknown";
  if (!health.ok || !health.contractOk || health.version === undefined) return "down";
  if (!health.nemesisPresent) return "degraded";
  return "ready";
}
