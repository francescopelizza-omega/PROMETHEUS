// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * env/util.ts — the PURE, dependency-free display helpers the Environments
 * components lean on (file 04 §3/§5/§9). NO react, NO node, NO engine-bridge
 * runtime — only string/number math the components render. This is the testable
 * core of the env UI (node:test covers it WITHOUT a DOM).
 *
 * GOLDEN RULE (C5): nothing here decides "safe". A gate badge's color/label is a
 * pure projection of the verdict tier the ENGINE already produced — these helpers
 * never score, never upgrade a verdict toward allow, never gate. Every engine
 * string a component renders is first run through `inert()` so a crafted package
 * name / reason can only ever be inert text.
 */

import type { SecSeverity, SecVerdict } from "../security/types.js";
import type { EnvGateBadge } from "./types.js";

/** The four engine verdict tiers (C3) a gate badge can carry. */
export type GateTier = "allow" | "warn" | "block" | "error";

/** The lifecycle state of one package row (mirrors core env-store §9). */
export type RowState =
  | "absent"
  | "pending"
  | "installed"
  | "enabled"
  | "disabled"
  | "outdated"
  | "blocked";

/** The ESC byte (0x1b) — lead of every ANSI escape (built, not a literal in source). */
const ESC = String.fromCharCode(0x1b);

/** ANSI CSI escape sequences (ESC [ … final-letter), all occurrences. */
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/** Any bare control byte (0x00–0x1f, 0x7f) — collapsed to a space. */
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}\\x7f]`, "g");

/** Remove ANSI + collapse control chars so an engine string is safe inert text. */
export function inert(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(ANSI, "").replace(CONTROL, " ").trim();
}

/** A semantic UI role (a ui token, never raw hex). */
export type EnvRole = "ok" | "warn" | "danger" | "muted" | "accent";

/** Map a verdict tier → its semantic role (allow=ok, warn=warn, block/error=danger). */
export function gateRole(tier: GateTier | undefined): EnvRole {
  switch (tier) {
    case "allow":
      return "ok";
    case "warn":
      return "warn";
    case "block":
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

/** A short glyph for a gate tier (inert; the badge renders this, not a decision). */
export function gateGlyph(tier: GateTier | undefined): string {
  switch (tier) {
    case "allow":
      return "✓";
    case "warn":
      return "⚠";
    case "block":
      return "⛔";
    case "error":
      return "⚠";
    default:
      return "·";
  }
}

/** A short label for a gate tier ("clean"/"warn"/"BLOCK"/"error"/"ungated"). */
export function gateLabel(tier: GateTier | undefined): string {
  switch (tier) {
    case "allow":
      return "clean";
    case "warn":
      return "warn";
    case "block":
      return "BLOCK";
    case "error":
      return "error";
    default:
      return "ungated";
  }
}

/** Does a gate tier REFUSE the install (block/error)? (drives the deep-red row). */
export function gateRefuses(tier: GateTier | undefined): boolean {
  return tier === "block" || tier === "error";
}

/** Resolve a semantic role → the CSS var the component paints with. */
export function roleVar(role: EnvRole): string {
  switch (role) {
    case "ok":
      return "var(--ok)";
    case "warn":
      return "var(--warn)";
    case "danger":
      return "var(--danger)";
    case "accent":
      return "var(--accent)";
    default:
      return "var(--text-secondary)";
  }
}

/** Map a row's lifecycle state → its semantic role (for the leading status dot). */
export function rowStateRole(state: RowState): EnvRole {
  switch (state) {
    case "installed":
    case "enabled":
      return "ok";
    case "outdated":
      return "accent";
    case "disabled":
      return "muted";
    case "blocked":
      return "danger";
    case "pending":
      return "warn";
    default:
      return "muted";
  }
}

/** A glyph for a row state (● installed · ⬆ outdated · ⏸ disabled · ⛔ blocked). */
export function rowStateGlyph(state: RowState): string {
  switch (state) {
    case "installed":
    case "enabled":
      return "●";
    case "outdated":
      return "⬆";
    case "disabled":
      return "⏸";
    case "blocked":
      return "⛔";
    case "pending":
      return "◌";
    default:
      return "○";
  }
}

/** Env-health → semantic role (ok=ok, degraded=warn, broken=danger, unknown=muted). */
export function healthRole(health: string | undefined): EnvRole {
  switch (health) {
    case "ok":
      return "ok";
    case "degraded":
      return "warn";
    case "broken":
      return "danger";
    default:
      return "muted";
  }
}

/** A glyph for an env health chip. */
export function healthGlyph(health: string | undefined): string {
  switch (health) {
    case "ok":
      return "✓";
    case "degraded":
      return "◐";
    case "broken":
      return "✗";
    default:
      return "?";
  }
}

/**
 * Format a byte count as a short human size (for the picker + delete confirm).
 * PURE: no locale dependency; binary units; one decimal above KB.
 */
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
  // bytes (< 1KB) already returned above as an integer; every KB+ unit shows one
  // decimal for precision, collapsing to integer once the value is large (≥ 100).
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * Is a destructive op (delete env, system install) allowed on this managed-by?
 * 'studio' envs are fully mutable; 'engine' envs are read-mostly (route to the
 * Model Hub); 'external'/system are install-locked by default. This is a UI
 * affordance gate, NOT a security decision — the engine still enforces.
 */
export function allowsDestructive(managedBy: string | undefined): boolean {
  return managedBy === "studio";
}

/** A short "managed by" chip label. */
export function managedByLabel(managedBy: string | undefined): string {
  switch (managedBy) {
    case "studio":
      return "Studio";
    case "engine":
      return "engine ⚙";
    case "external":
      return "external";
    default:
      return "—";
  }
}

/**
 * The per-step validity of the create-env wizard step ① inputs (§3.3). PURE: a
 * non-empty name with no path separators / control chars, and a non-empty base
 * interpreter. The wizard disables "next" until this is true. NOT a security
 * decision — the sidecar still validates before creating.
 */
export function createStepValid(input: {
  name: string;
  base: string;
}): { ok: boolean; reason?: string } {
  const name = input.name.trim();
  if (name.length === 0) return { ok: false, reason: "name is required" };
  if (name.length > 128) return { ok: false, reason: "name is too long" };
  if (/[\x00-\x1f]/.test(name)) return { ok: false, reason: "name has control characters" };
  if (/[/\\]/.test(name)) return { ok: false, reason: "name must not contain a path separator" };
  if (input.base.trim().length === 0) return { ok: false, reason: "an interpreter is required" };
  return { ok: true };
}

/** A wizard template package row toggle state (checked + editable spec). */
export interface WizardPkgRow {
  name: string;
  spec: string;
  optional: boolean;
  checked: boolean;
  note?: string;
}

/**
 * Summarise the wizard's per-package gate plan (§3.3 step ③): how many packages
 * the user has CHECKED (will be staged + scanned). Optional rows default
 * unchecked. PURE counting only.
 */
export function plannedCount(rows: WizardPkgRow[]): number {
  return rows.filter((r) => r.checked).length;
}

/** The verbs legal as ROW ACTIONS for a given state (§3.2 / §9 — UI affordance). */
export function rowActions(state: RowState): string[] {
  switch (state) {
    case "installed":
    case "enabled":
      return ["update", "disable", "remove", "info"];
    case "outdated":
      return ["update", "disable", "remove", "info"];
    case "disabled":
      return ["enable", "remove", "info"];
    case "blocked":
      return ["rescan", "remove", "info"];
    case "pending":
      return ["info"];
    default:
      return ["install", "info"];
  }
}

// ── GateVerdictSheet adapter (PURE — lives here, not the .tsx, so node:test can
//    cover it: Node's type-stripper can't load a JSX module). ─────────────────

const EMPTY_SEVERITY: Record<SecSeverity, number> = {
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
  INFO: 0,
};

/**
 * Adapt an `EnvGateBadge` (the camelCased gate summary a gated-install result
 * carries) → the structural `SecVerdict` the SHARED file-03 `<VerdictSheet/>`
 * renders. We DO NOT fabricate findings/counts we don't have: the sheet shows the
 * engine's `reasons` as blocking_reasons + the recommendation, and a FAIL-CLOSED
 * `safe_to` triad derived ONLY from the tier (block/error ⇒ not safe). This is
 * presentation re-shaping, never a security decision (C5) — the verdict is the
 * engine's, carried through unchanged. Reasons are run through `inert()`.
 */
export function gateToVerdict(gate: EnvGateBadge, target: string): SecVerdict {
  const tier = gate.verdict;
  const refuse = tier === "block" || tier === "error";
  const safe = tier === "allow";
  const reasons = (gate.reasons ?? []).map((r) => inert(r)).filter((r) => r.length > 0);
  return {
    schema: "nemesis.verdict/1",
    tool: "nemesis",
    tool_version: "",
    target,
    target_kind: "package",
    target_sha256: null,
    scanned_at: gate.scannedAt ?? "",
    duration_s: 0,
    verdict: tier,
    risk_score: typeof gate.score === "number" ? gate.score : refuse ? 100 : 0,
    exit_code: 0,
    severity_counts: { ...EMPTY_SEVERITY },
    class_counts: {},
    findings_by_class: {},
    safe_to: {
      install: safe,
      run_plug_and_play: safe,
      use_as_ai_cli_agent: safe,
    },
    recommendation: gate.recommendation ?? "",
    blocking_reasons: reasons,
    top_findings: [],
    unscannable: false,
    disinfection: null,
    provenance: {
      ruleset_sha: "",
      indicators_loaded: {},
      db: { seeded: true, age_days: 0, stale: false },
      findings_ignored: 0,
      files_scanned: 0,
      sca_unscanned_ecosystems: [],
    },
    policy: "",
    host: "",
    cached: false,
  };
}
