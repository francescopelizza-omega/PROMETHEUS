// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * security/verdict.ts — the SINGLE SOURCE OF TRUTH for the verdict model (C3).
 *
 * Two distinct axes, never conflated:
 *   - VerdictTier  = the decision    (nemesis exit tiers 0/10/20/2).
 *   - Severity     = how bad a finding is. `clean` is a SEVERITY, never a verdict.
 *
 * GOLDEN RULE (C5): JS never decides "safe". It only renders an engine/nemesis
 * verdict. A missing / timed-out / unparseable scanner => verdict "error" =>
 * fail-closed BLOCK. None of the helpers below ever upgrade a verdict toward
 * "allow"; they only ever map or downgrade.
 */

/** The decision axis — mirrors nemesis decision exit codes 0 / 10 / 20 / 2. */
export type VerdictTier = "allow" | "warn" | "block" | "error";

/** How severe an individual finding is. `clean` means "no finding", a SEVERITY. */
export type Severity = "clean" | "low" | "medium" | "high" | "critical";

export interface Finding {
  klass: "malware" | "secret" | "vuln" | "sca";
  severity: Severity;
  rule: string;
  where: string;
}

export interface SecurityVerdict {
  verdict: VerdictTier;
  risk_score: number;
  signed: boolean;
  findings: Finding[];
  /**
   * The gate's free-text BLOCKING REASONS, when it produced prose rather than findings.
   *
   * A separate field because they are a separate axis. `gateCommand` used to map each reason
   * into a `Finding` with `rule: "nemesis"` and
   * `severity: verdict === "warn" ? "medium" : "high"` — an invented rule id in the slot that
   * everywhere else holds a real one, and a severity that is the DECISION TIER restated as if
   * it were an independent measurement. handoff §4 forbids exactly that conflation
   * ("Severity vocabulary is clean|low|medium|high|critical; decision tier is
   * allow|warn|block — never conflate"), and the fabrication was invisible only because no
   * surface renders a command gate's findings table yet.
   */
  blockingReasons?: readonly string[];
  scannedAt: string;
  target: string;
}

export interface NemesisVerdictRef {
  verdict: VerdictTier;
  score: number;
  signedAt: string;
  findingsRef?: string;
}

export type GateBadge = NemesisVerdictRef;

export interface ForcedDanger {
  label: string;
  verdict: "block" | "error";
  risk_score: number;
  blocking_reasons: string[];
}

/**
 * Map a nemesis decision exit code to a VerdictTier.
 *   0 -> allow · 10 -> warn · 20 -> block · 2 (and ANYTHING else) -> error.
 * Fail-closed: any unrecognised code is treated as "error" (a BLOCK).
 */
export function tierFromExitCode(code: number | null | undefined): VerdictTier {
  switch (code) {
    case 0:
      return "allow";
    case 10:
      return "warn";
    case 20:
      return "block";
    case 2:
      return "error";
    default:
      // Unknown / null / negative-on-signal => fail closed.
      return "error";
  }
}

/**
 * Normalise nemesis's verdict string (the `verdict` field of its JSON) to a
 * VerdictTier. nemesis emits lowercase allow|warn|block|error already, but we
 * canonicalise defensively and fail closed on anything unexpected.
 */
export function normalizeVerdict(raw: unknown): VerdictTier {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "allow" || v === "warn" || v === "block" || v === "error") return v;
  return "error";
}

/** Normalise a nemesis severity token (CRITICAL/HIGH/…) to our Severity. */
export function normalizeSeverity(raw: unknown): Severity {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  switch (s) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    case "info":
    case "clean":
    case "none":
    case "":
      return "clean";
    default:
      // Unknown severity from a finding is, conservatively, low (it IS a finding).
      return "low";
  }
}

/** Normalise a nemesis finding `class` token to our Finding.klass union. */
export function normalizeKlass(raw: unknown): Finding["klass"] {
  const k = String(raw ?? "")
    .trim()
    .toLowerCase();
  switch (k) {
    case "malware":
      return "malware";
    case "secret":
      return "secret";
    case "vuln":
    case "vulnerability":
      return "vuln";
    case "sca":
    case "supply_chain":
    case "dependency":
      return "sca";
    default:
      // An unclassified finding is treated as malware — the most conservative bucket.
      return "malware";
  }
}

/**
 * Is this tier blocking? warn is informational; block & error halt. allow passes.
 * Used by callers (and the engine-bridge install path) to decide gating.
 */
export function isBlockingTier(tier: VerdictTier): boolean {
  return tier === "block" || tier === "error";
}

/**
 * Why this verdict decided what it decided, in the judge's own words.
 *
 * A COMMAND gate answers in prose (`blockingReasons`); a FILE gate answers in `findings`.
 * Both are legitimate, and a surface that only wants to say "why" should not have to know
 * which judge ran — before this existed, every such surface read `findings` alone, so once
 * `gateCommand` correctly stopped fabricating findings out of prose the reason went silently
 * empty everywhere: the exec audit recorded the bare word "block", the model got an empty
 * bullet list, the human saw a refusal with no cause, and a refused workspace hook could not
 * name the rule. A fail-closed gate whose audit trail cannot say why it closed is not
 * evidence of anything.
 *
 * Prose wins when present: it IS the command gate's answer, and such a verdict carries no
 * findings to fall back to. The fail-closed path still answers with a real finding
 * (`nemesis-unavailable`), which is why findings are the fallback rather than an alternative.
 */
export function verdictReasons(v: SecurityVerdict): string[] {
  const prose = (v.blockingReasons ?? []).filter((r) => r.trim().length > 0);
  if (prose.length > 0) return [...prose];
  return v.findings.map((f) => f.where).filter((w) => w.trim().length > 0);
}
