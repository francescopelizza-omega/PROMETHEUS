// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * patterns/types.ts — the renderer-facing DISPLAY shapes the §3.2 product patterns
 * render, as @prometheus/ui-LOCAL structural mirrors (same discipline as security/
 * env/modelhub types.ts).
 *
 * WHY MIRRORED HERE (not imported): @prometheus/ui is a sandboxed presentational
 * package (C5) — it may import ONLY `react` + its own modules, never @prometheus/
 * engine-bridge or @prometheus/core runtime, and has no project reference to them,
 * so a cross-package type import would not resolve under `tsc -b`. These interfaces
 * are STRUCTURAL mirrors of the engine shapes (nemesis verdict, OPEN_MODELS rows,
 * cmd_list rows, superscan agent counts, sidecar JSON-lines). Because they are
 * structural, the renderer (which DOES depend on both packages) passes a real
 * engine value straight into these props with no adapter.
 *
 * GOLDEN RULE (C5): DISPLAY shapes only. The patterns NEVER score, fit, allowlist,
 * or decide "safe" — they render a verdict/fit the engine already computed and take
 * every action as a callback prop. Engine strings are rendered inert (text only).
 */

import type { VerdictTier } from "../tokens.js";

/* ── verdict / findings (mirror of nemesis verdict + active_findings[]) ───────── */

/** A finding row's shape (mirror of nemesis `active_findings[]`, §3.2 FindingRow). */
export interface PatternFinding {
  /** Engine severity. Accepts the engine's lowercase form AND the GUI's uppercased
   *  form (severityKey is case-insensitive + fail-closed). */
  severity:
    | "CRITICAL"
    | "HIGH"
    | "MEDIUM"
    | "LOW"
    | "INFO"
    | "critical"
    | "high"
    | "medium"
    | "low"
    | "info"
    | (string & {});
  rule_id: string;
  /** repo-relative path (rel_path). */
  rel_path: string;
  line?: number;
  /** finding class — icon-tinted, never the sole signal (08 §2.2). Optional: raw
   *  engine active_findings[] carry no klass; the bridge synthesizes one. */
  klass?: "malware" | "secret" | "vuln" | "sca" | (string & {});
  /** the human reason; rendered inert. */
  detail?: string;
}

/** The full scan report a VerdictPanel renders (mirror of nemesis scan_report). */
export interface PatternVerdictReport {
  verdict: VerdictTier;
  risk_score: number;
  target?: string;
  blocking_reasons: string[];
  active_findings: PatternFinding[];
  /** per-class counts for the filter chips (malware/secret/vuln/sca). */
  class_counts?: Partial<Record<string, number>>;
}

/* ── model card (mirror of an OPEN_MODELS row + a Cookbook fit) ───────────────── */

/** A quantization chip (GGUF/FP8/AWQ/Q4_K_M…). */
export interface ModelQuant {
  label: string;
  /** does it fit the VRAM budget? drives the meter band + "fits/>budget" copy. */
  fits?: boolean;
}

/** A model card's display data (mirror of OPEN_MODELS row + a VRAM fit probe). */
export interface ModelCardData {
  id: string;
  name: string;
  license: string;
  /** e.g. "0.6B–32B · 30B/235B MoE". */
  params?: string;
  /** 0..1 fraction of the VRAM budget the chosen quant uses (the fit meter). */
  vramFitRatio?: number;
  /** "fits 16GB ✓" / ">24GB ✗" caption (engine fit math, rendered inert). */
  fitCaption?: string;
  quants: ModelQuant[];
  local?: boolean;
  served?: boolean;
  /** the pre-download/serve nemesis verdict (carried on the CTA). */
  verdict?: VerdictTier;
  riskScore?: number;
}

/* ── venv / package rows (mirror of venv list + pip/conda state) ──────────────── */

/** A venv row (mirror of the §5.3 venv list row). */
export interface VenvRowData {
  name: string;
  pythonVersion: string;
  packageCount?: number;
  sizeBytes?: number;
  active?: boolean;
  path?: string;
}

/** A package row (mirror of the §5.3 package table row + its pre-install gate). */
export interface PackageRowData {
  name: string;
  version?: string;
  state: "installed" | "pending" | "missing" | "disabled";
  /** the pre-install gate verdict carried as a badge (§5.3). */
  verdict?: VerdictTier;
  sizeBytes?: number;
}

/* ── catalog item (mirror of a cmd_list row) ──────────────────────────────────── */

/** A catalog row (mirror of cmd_list `{ name, tier, scope }`, §5.5). */
export interface CatalogItemData {
  name: string;
  /** Official / External / Documented-only (§5.5 tier glyphs). */
  tier: "official" | "external" | "documented";
  scope?: string;
  /** the pre-install gate verdict (External is always scanned). */
  verdict?: VerdictTier;
  rank?: number;
  /** install presence for the status mark: green ✓ present / red ✗ absent / · unknown. */
  presence?: "present" | "absent" | "unknown";
}

/* ── agent status (mirror of superscan agent counts) ──────────────────────────── */

/** Presence of an agent's scan (mirror of superscan `present/forgotten/absent`). */
export type AgentPresence = "present" | "forgotten" | "absent";

/** An agent's scan counts `Np Ss Mm Xx Rr Cc` (the TUI ScanView, §3.2 AgentStatusDot).
 *  `extensions` is the engine's `x` facet (prometheus.py counts {plugins,skills,mcp,
 *  extensions,rules,commands}) — pass a superscan agent.counts straight through. */
export interface AgentCounts {
  plugins?: number;
  skills?: number;
  mcp?: number;
  extensions?: number;
  rules?: number;
  commands?: number;
}

/* ── stream log (mirror of a sidecar stderr JSON-line) ────────────────────────── */

/** One JSON-lines log record the StreamLog tails (mirror of sidecar stderr). */
export interface StreamLogLine {
  /** monotonic key for React. */
  id: string;
  /** the log level → severity tint (08 §2.2). */
  level?: "info" | "debug" | "warn" | "error" | "success";
  /** the message text; rendered inert (ANSI/control-stripped at the boundary). */
  text: string;
  /** optional timestamp string (already formatted upstream). */
  at?: string;
}

/* ── engine state (mirror of the bridge connectivity probe) ───────────────────── */

/** The engine-connectivity facts the EngineState molecule renders (§3.2). */
export interface EngineStateData {
  /** is python3 + the sidecar reachable? */
  pythonOk: boolean;
  /** is the nemesis binary present? */
  nemesisPresent: boolean;
  /** threat-DB freshness; `stale` raises the amber shield (08 §5.2 error/stale). */
  dbFreshness?: "fresh" | "stale" | "absent";
  /** the latest gate tier (drives the shield color); undefined ⇒ unknown. */
  shield?: VerdictTier;
}
