// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * patterns/util.ts — the PURE, dependency-free display helpers the §3.2 product
 * patterns lean on (08 §3.2). NO react, NO node, NO engine-bridge runtime — only
 * the string/number projections the patterns render. This is the testable core of
 * the product-pattern layer (node:test exercises it WITHOUT a DOM).
 *
 * GOLDEN RULE (C5): nothing here decides "safe", scores, fits, or gates. A
 * verdict/severity/state badge's color+glyph+label is a PURE projection of a value
 * the ENGINE already computed (nemesis verdict, finding severity, cmd_status
 * state, superscan presence). An unknown/garbage input fails CLOSED — toward the
 * loud/unsafe descriptor, never toward "allow"/"clean". Every engine-sourced
 * string a pattern renders is first run through `inert()` so a crafted model id /
 * rule_id / path / log line can only ever become inert text.
 *
 * The role→CSS-var maps mirror the SEMANTIC token keys in tokens.ts (VERDICT_ROLE
 * / SEVERITY_ROLE / STATE_ROLE / KLASS_ROLE) — never a raw hex (08 §6). The verdict
 * thresholds + glyph/label sets are byte-identical to the engine/TUI source of
 * truth so green/amber/red mean the same thing everywhere (08 rule #1).
 */

import {
  KLASS_ROLE,
  type RoleToken,
  SEVERITY_GLYPH,
  SEVERITY_ROLE,
  STATE_ROLE,
  type Severity,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  VERDICT_ROLE,
  type VerdictTier,
} from "../tokens.js";
import type {
  AgentCounts,
  AgentPresence,
  CatalogItemData,
  PatternFinding,
  StreamLogLine,
} from "./types.js";

/* ── inert (the shared ANSI/control sanitiser) ─────────────────────────────── */

/** The ESC byte (0x1b) — lead of every ANSI escape (built, not a literal in source). */
const ESC = String.fromCharCode(0x1b);
/** ANSI CSI escape sequences (ESC [ … final-letter), all occurrences. */
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
/** Any bare control byte (0x00–0x1f, 0x7f) — collapsed to a space. */
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}\\x7f]`, "g");

/**
 * Remove ANSI escapes + collapse control bytes so an engine string is safe inert
 * text. Non-strings return "". Pure; the COMPONENT renders the result as a React
 * TEXT child, never via dangerouslySetInnerHTML (08 §2.1).
 */
export function inert(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(ANSI, "").replace(CONTROL, " ").trim();
}

/* ── role → CSS var (the only mapping that paints; never a raw hex, 08 §6) ──── */

/** Resolve a semantic RoleToken → its CSS var (text-secondary is the lone non-`--role`). */
export function roleVar(role: RoleToken): string {
  return role === "text-secondary" ? "var(--text-secondary)" : `var(--${role})`;
}

/* ── verdict → {role,glyph,label,var} (PURE projection of the nemesis tier) ──── */

/** Map a verdict tier → its semantic role token (08 §2.2; unknown ⇒ danger, fail-closed). */
export function verdictRole(verdict: VerdictTier | undefined): RoleToken {
  if (verdict === undefined) return "text-secondary";
  return VERDICT_ROLE[verdict] ?? "danger";
}

/** A verdict tier's glyph (carries meaning WITHOUT color, 08 §7; unknown ⇒ ⚠). */
export function verdictGlyph(verdict: VerdictTier | undefined): string {
  if (verdict === undefined) return "·";
  return VERDICT_GLYPH[verdict] ?? "⚠";
}

/** A verdict tier's UPPERCASE label (allow → "CLEAN"; unknown ⇒ "SCAN FAILED"). */
export function verdictLabel(verdict: VerdictTier | undefined): string {
  if (verdict === undefined) return "PENDING";
  return VERDICT_LABEL[verdict] ?? "SCAN FAILED";
}

/** The CSS var a verdict tier paints with (the one-call helper components use). */
export function verdictVar(verdict: VerdictTier | undefined): string {
  return roleVar(verdictRole(verdict));
}

/* ── severity → {role,glyph,var} (PURE projection of a finding's severity) ───── */

/**
 * Map the engine's finding severity → the lowercase tokens.ts key. CASE-INSENSITIVE
 * (the engine emits lowercase `severity`, prometheus.py; the GUI bridge may upper-
 * case it) and FAIL-CLOSED: an unrecognized non-empty value resolves to the LOUDEST
 * descriptor (`critical`), never to `clean`/allow (the §util golden rule).
 */
export function severityKey(severity: PatternFinding["severity"]): Severity {
  switch (String(severity).toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "info":
      return "clean"; // INFO → the calm "clean" role/glyph
    default:
      return "critical"; // unrecognized non-empty ⇒ loudest (fail-closed)
  }
}

/** A finding severity's semantic role (08 §2.2; INFO → the muted text-secondary). */
export function severityRole(severity: PatternFinding["severity"]): RoleToken {
  const k = severityKey(severity);
  if (k === "clean") return "text-secondary";
  return SEVERITY_ROLE[k] ?? "danger";
}

/** A finding severity's glyph (✓ ▲ ⛔; carries meaning without color). */
export function severityGlyph(severity: PatternFinding["severity"]): string {
  return SEVERITY_GLYPH[severityKey(severity)] ?? "⚠";
}

/** The CSS var a finding severity paints with (the severity ▍ bar + chip). */
export function severityVar(severity: PatternFinding["severity"]): string {
  return roleVar(severityRole(severity));
}

/**
 * The rank of a severity (CRITICAL=4 … INFO=0) — used to SORT findings loudest-
 * first. Pure; an unknown value sorts as INFO (0). NEVER changes a finding's
 * severity, only its display order.
 */
export function severityRank(severity: PatternFinding["severity"]): number {
  switch (String(severity).toLowerCase()) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    case "info":
      return 0;
    default:
      return 4; // unrecognized ⇒ sort loudest-first (fail-closed for ordering)
  }
}

/** Sort findings loudest-first (CRITICAL→INFO), stable within a severity. Pure copy. */
export function sortFindings(findings: readonly PatternFinding[]): PatternFinding[] {
  return [...(findings ?? [])]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => severityRank(b.f.severity) - severityRank(a.f.severity) || a.i - b.i)
    .map(({ f }) => f);
}

/* ── klass → {role,var,label} (icon tint only, never the sole signal, 08 §2.2) ── */

/** A finding klass's semantic role (malware=danger, secret/vuln=warn, sca=info). */
export function klassRole(klass: string): RoleToken {
  return KLASS_ROLE[klass as keyof typeof KLASS_ROLE] ?? "text-secondary";
}

/** The CSS var a finding klass tints its tag with (icon tint only). */
export function klassVar(klass: string): string {
  return roleVar(klassRole(klass));
}

/* ── component-state → {role,glyph,var} (the §5.3 package/catalog state pills) ── */

/** The component lifecycle states a state pill can carry (mirror of cmd_status). */
export type StatePill =
  | "enabled"
  | "installed"
  | "disabled"
  | "muted"
  | "absent"
  | "missing"
  | "pending";

/** Map a component-state → its semantic role (08 §2.2; pending → muted/accent). */
export function stateRole(state: StatePill): RoleToken {
  if (state === "pending") return "accent";
  return STATE_ROLE[state] ?? "text-secondary";
}

/** A glyph for a component-state (● enabled · ◐ pending · ○ absent · ✗ missing). */
export function stateGlyph(state: StatePill): string {
  switch (state) {
    case "enabled":
    case "installed":
      return "●";
    case "disabled":
    case "muted":
      return "◑";
    case "pending":
      return "◐";
    case "missing":
      return "✗";
    default:
      return "○"; // absent
  }
}

/** The CSS var a component-state paints its pill with. */
export function stateVar(state: StatePill): string {
  return roleVar(stateRole(state));
}

/* ── risk score → band (the §5.2 gauge; the one place a number becomes a feeling) ── */

/** A risk band, banded by the nemesis verdict thresholds (block ≥ 70, warn ≥ 30). */
export type RiskBand = "ok" | "warn" | "danger";

/** The §5.2 thresholds (block ≥ 70, warn ≥ 30) — mirrors the engine's gate bands. */
export const RISK_WARN_THRESHOLD = 30;
export const RISK_BLOCK_THRESHOLD = 70;

/**
 * Band a 0–100 risk score by the verdict thresholds (08 §5.2 — "82 (block ≥ 70)").
 * PURE: clamps to [0,100]; a NaN/garbage score fails CLOSED to the danger band.
 * NEVER recomputes risk — it only buckets the number the engine already produced.
 */
export function riskBand(score: number): RiskBand {
  if (!Number.isFinite(score)) return "danger";
  const s = Math.max(0, Math.min(100, score));
  if (s >= RISK_BLOCK_THRESHOLD) return "danger";
  if (s >= RISK_WARN_THRESHOLD) return "warn";
  return "ok";
}

/** The CSS var a risk score's band paints with (the gauge fill). */
export function riskVar(score: number): string {
  return roleVar(riskBand(score));
}

/** Clamp a risk score to the [0,100] gauge range (NaN/garbage ⇒ 100, fail-closed). */
export function clampRisk(score: number): number {
  if (!Number.isFinite(score)) return 100;
  return Math.max(0, Math.min(100, score));
}

/**
 * The §5.2 gauge fill fraction (0..1) for a risk score. PURE: clamps. Drives the
 * banded bar width; the band color comes from `riskBand`.
 */
export function riskFraction(score: number): number {
  return clampRisk(score) / 100;
}

/* ── catalog tier → {glyph,label} (the §5.5 tier glyphs) ───────────────────── */

/** A catalog tier's glyph (✓ external · ◆ official · ⓘ documented-only, 08 §5.5). */
export function tierGlyph(tier: CatalogItemData["tier"]): string {
  switch (tier) {
    case "official":
      return "◆";
    case "documented":
      return "ⓘ";
    default:
      return "✓"; // external
  }
}

/** A catalog tier's human label (the §5.5 tree section). */
export function tierLabel(tier: CatalogItemData["tier"]): string {
  switch (tier) {
    case "official":
      return "official";
    case "documented":
      return "documented-only";
    default:
      return "external";
  }
}

/**
 * Is a catalog item DOCUMENTED-ONLY — never an inline Install (it routes to a
 * guided flow instead, 08 §5.5)? PURE flag the CatalogItem reads to swap its CTA.
 */
export function isDocumentedOnly(tier: CatalogItemData["tier"]): boolean {
  return tier === "documented";
}

/* ── agent presence → {glyph,role,var} (the §3.2 AgentStatusDot ● ◐ ○) ──────── */

/** Map a superscan agent presence → its TUI dot glyph (● present · ◐ forgotten · ○ absent). */
export function presenceGlyph(presence: AgentPresence): string {
  switch (presence) {
    case "present":
      return "●";
    case "forgotten":
      return "◐";
    default:
      return "○"; // absent
  }
}

/** Map an agent presence → its semantic role (present=ok, forgotten=warn, absent=muted). */
export function presenceRole(presence: AgentPresence): RoleToken {
  switch (presence) {
    case "present":
      return "ok";
    case "forgotten":
      return "warn";
    default:
      return "text-secondary"; // absent
  }
}

/** The CSS var an agent presence paints its dot with. */
export function presenceVar(presence: AgentPresence): string {
  return roleVar(presenceRole(presence));
}

/**
 * Render the §3.2 ScanView counts string `Np Ss Mm Xx Rr Cc` for an agent (plugins
 * / skills / mcp / external / rules / commands). PURE: omits zero/undefined facets
 * so an agent with only plugins reads "3p"; an all-zero agent reads "". Exactly the
 * TUI ScanView grammar.
 */
export function countsLabel(counts: AgentCounts | undefined): string {
  if (!counts) return "";
  const parts: string[] = [];
  const push = (n: number | undefined, suffix: string) => {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) parts.push(`${n}${suffix}`);
  };
  push(counts.plugins, "p");
  push(counts.skills, "s");
  push(counts.mcp, "m");
  push(counts.extensions, "x");
  push(counts.rules, "r");
  push(counts.commands, "c");
  return parts.join(" ");
}

/** The total count across an agent's facets (the AgentStatusDot summary badge). */
export function countsTotal(counts: AgentCounts | undefined): number {
  if (!counts) return 0;
  const vals = [
    counts.plugins,
    counts.skills,
    counts.mcp,
    counts.extensions,
    counts.rules,
    counts.commands,
  ];
  return vals.reduce<number>((sum, n) => sum + (typeof n === "number" && n > 0 ? n : 0), 0);
}

/* ── stream-log level → tint (the §3.2 StreamLog severity-tinted JSON-lines) ──── */

/** A log line's level (mirror of a sidecar JSON-line `level`). */
export type StreamLevel = NonNullable<StreamLogLine["level"]>;

/** Map a stream-log level → its semantic role (error=danger, warn=warn, success=ok). */
export function streamLevelRole(level: StreamLogLine["level"]): RoleToken {
  switch (level) {
    case "error":
      return "danger";
    case "warn":
      return "warn";
    case "success":
      return "ok";
    case "info":
      return "info";
    default:
      return "text-secondary"; // debug / undefined
  }
}

/** The CSS var a stream-log line is tinted with (the severity-tint, 08 §3.2). */
export function streamLevelVar(level: StreamLogLine["level"]): string {
  return roleVar(streamLevelRole(level));
}

/* ── engine connectivity → {shield tier, label} (the §3.2 EngineState molecule) ── */

/** The engine facts the shield projects (mirror of the bridge connectivity probe). */
export interface EngineProbe {
  pythonOk: boolean;
  nemesisPresent: boolean;
  dbFreshness?: "fresh" | "stale" | "absent";
  shield?: VerdictTier;
}

/**
 * Derive the STATUS-BAR shield tier from the engine probe (08 §4.2/§5.2). PURE +
 * FAIL-CLOSED: python down OR nemesis missing OR the DB absent ⇒ `error` (the loud
 * ⚠ "scan failed — treat as unsafe" shield); a `stale` DB downgrades a clean shield
 * to `warn`; otherwise the latest gate `shield` tier rides through. NEVER upgrades
 * toward `allow` — an unknown/degraded engine can only darken the shield.
 */
export function shieldTier(probe: EngineProbe): VerdictTier {
  if (!probe.pythonOk || !probe.nemesisPresent) return "error";
  if (probe.dbFreshness === "absent") return "error";
  const base = probe.shield ?? "allow";
  if (probe.dbFreshness === "stale" && base === "allow") return "warn";
  return base;
}

/** A one-line human summary of the engine probe (the EngineState tooltip). */
export function engineSummary(probe: EngineProbe): string {
  const py = probe.pythonOk ? "python ok" : "python down";
  const nem = probe.nemesisPresent ? "nemesis present" : "nemesis missing";
  const db =
    probe.dbFreshness === "stale"
      ? "db stale"
      : probe.dbFreshness === "absent"
        ? "db absent"
        : "db fresh";
  return `${py} · ${nem} · ${db}`;
}

/* ── number / size formatting (the §3.2 rows + meters) ─────────────────────── */

/** Format a byte count as a short human size (venv/package rows). Binary units. */
export function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Format a count compactly (1_200_000 → "1.2M", 410 → "410"); negative/NaN ⇒ "—". */
export function formatCount(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Clamp a VRAM-fit ratio (0..1 fraction of the budget the chosen quant uses) for
 * the §3.2 ModelCard fit meter. PURE: NaN/garbage ⇒ 1 (full bar, fail toward
 * ">budget"); >1 clamps to 1 (the bar is full when it overflows). NEVER fit-scores
 * — it renders the ratio the engine's fit math produced.
 */
export function clampFitRatio(ratio: number | undefined): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return 1;
  return Math.max(0, Math.min(1, ratio));
}

/**
 * The §5.4 VRAM-fit band: a quant that FITS (engine said so via `fits`) is green;
 * one that does not is red; an unknown `fits` bands by the ratio headroom (≤0.85 ⇒
 * tight-ok, ≤1 ⇒ warn, else danger). PURE — it renders the engine's fit, never decides it.
 */
export function fitMeterRole(fits: boolean | undefined, ratio: number | undefined): RoleToken {
  if (fits === true) return "ok";
  if (fits === false) return "danger";
  const r = clampFitRatio(ratio);
  if (r <= 0.85) return "ok";
  if (r < 1) return "warn";
  return "danger";
}

/** The CSS var the ModelCard fit meter fills with (banded by `fitMeterRole`). */
export function fitMeterVar(fits: boolean | undefined, ratio: number | undefined): string {
  return roleVar(fitMeterRole(fits, ratio));
}

/**
 * A fixed-width block meter string for a 0..1 fraction (the §5.4 "████████░░" VRAM
 * meter rendered in mono when a div bar is not wanted). PURE; clamps; `cells` wide.
 */
export function meterBar(fraction: number, cells = 14): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(f * cells);
  return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
}
