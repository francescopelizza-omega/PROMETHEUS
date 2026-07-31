/**
 * main/verdict-map.ts — pure mappers from engine/nemesis results to the
 * renderer-safe IPC shapes. Extracted from the ipcMain handlers so they are
 * unit-testable WITHOUT importing electron (node:test runs them after a plain
 * tsc emit).
 *
 * GOLDEN RULE (C5): none of these upgrade a verdict toward "allow". The
 * fail-closed paths (no target, thrown error) always produce verdict "error"
 * (a BLOCK) with risk 100 — the renderer renders a block, it never assumes safe.
 */

import type { SecurityVerdict, Severity, VerdictTier } from "@prometheus/engine-bridge";

import type { GateResult } from "../shared/ipc-contract.js";

const SEVERITY_ORDER: Severity[] = ["clean", "low", "medium", "high", "critical"];

/** The highest finding severity present in a verdict (clean if none). */
export function topSeverity(v: SecurityVerdict): Severity {
  let max: Severity = "clean";
  for (const f of v.findings) {
    if (SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(max)) {
      max = f.severity;
    }
  }
  return max;
}

/** Map a real SecurityVerdict to the renderer-safe GateResult (no upgrade). */
export function toGateResult(v: SecurityVerdict): GateResult {
  const blocked = v.verdict === "block" || v.verdict === "error";
  return {
    ok: !blocked,
    verdict: v.verdict,
    severity: topSeverity(v),
    riskScore: v.risk_score,
    signed: v.signed,
    findingsCount: v.findings.length,
    target: v.target,
    scannedAt: v.scannedAt,
    detail: v,
  };
}

/**
 * The fail-closed GateResult (C5): used when there is no target, or when the
 * gate threw a hard error. ALWAYS verdict "error" (BLOCK), risk 100, ok:false.
 */
export function failClosedGate(
  target: string,
  error: string,
  scannedAt: string = new Date().toISOString(),
): GateResult {
  const verdict: VerdictTier = "error";
  return {
    ok: false,
    verdict,
    severity: "clean",
    riskScore: 100,
    signed: false,
    findingsCount: 0,
    target,
    scannedAt,
    error,
  };
}
