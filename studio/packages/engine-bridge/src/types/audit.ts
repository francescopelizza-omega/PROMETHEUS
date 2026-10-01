// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/audit.ts — the `audit` envelope (file 02 §3.3).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json audit caveman` @ 0.15.0):
 *   {"command":"audit","ok":false,
 *    "request":{"plugin":"caveman"},
 *    "audits":[{"agent":"claude","method":"claude_plugin",
 *      "scan_report":{"verdict":"clean","identity":"655b...","scanned_files":174,
 *                     "active_findings":[],"downgraded_count":48},
 *      "nemesis_verdicts":[{"source":"JuliusBrussee/caveman","verdict":"block",
 *                           "risk_score":100,"recommendation":"DO NOT install...",
 *                           "blocking_reasons":["DROP-001 @ ...", ...]}]}],
 *    "worst_verdict":"critical","_exit":1}
 *
 * Two distinct axes appear and MUST NOT be conflated (C3):
 *   - scan_report.verdict + worst_verdict are SEVERITY (clean..critical).
 *   - nemesis_verdicts[].verdict is a VERDICT TIER (allow|warn|block|error).
 * active_findings was [] in the clean case; the field shape below is from the
 * file-02 spec (rule_id/severity/desc/snippet/context/rel_path/line).
 */
import type { EnvelopeBase, Severity, VerdictTier } from "./envelope.js";

/** One active (non-downgraded) finding row in a scan_report. */
export interface AuditFinding {
  rule_id: string;
  /** raw severity token from the scanner (CRITICAL/HIGH/…); not normalised here. */
  severity: string;
  desc: string;
  snippet: string;
  context: string;
  rel_path: string;
  line: number;
}

/** The built-in regex scan report for one (plugin,agent) artifact set. */
export interface AuditScanReport {
  /** SEVERITY axis: clean | low | medium | high | critical. */
  verdict: Severity;
  identity: string;
  scanned_files: number;
  active_findings: AuditFinding[];
  downgraded_count: number;
}

/** One deep nemesis-gate verdict per remote source backing a (plugin,agent). */
export interface AuditNemesisVerdict {
  source: string;
  /** DECISION axis: allow | warn | block | error. */
  verdict: VerdictTier;
  risk_score: number | null;
  recommendation: string;
  blocking_reasons: string[];
}

/** One per-(agent,method) audit entry. */
export interface AuditEntry {
  agent: string;
  method: string;
  scan_report: AuditScanReport;
  nemesis_verdicts: AuditNemesisVerdict[];
}

export type AuditEnvelope = EnvelopeBase<{
  command: "audit";
  request: { plugin: string };
  /** worst SEVERITY across every audit entry (clean..critical). */
  worst_verdict: Severity;
  audits: AuditEntry[];
}>;
