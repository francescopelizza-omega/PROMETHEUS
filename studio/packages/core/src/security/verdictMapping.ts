/**
 * core/security/verdictMapping.ts — the ONLY verdict→display map (file 03 §3).
 *
 * This is a PURE DISPLAY mapping keyed on the engine's `VerdictTier`. It is the
 * single place the GUI decides a verdict's color / label / default action /
 * override affordance. It is the §3 table, verbatim:
 *
 *   | verdict | color | label                       | defaultAction | override |
 *   |---------|-------|-----------------------------|---------------|----------|
 *   | allow   | green | SAFE — no known threats found | proceed      | —        |
 *   | warn    | amber | REVIEW                      | hold          | install-anyway |
 *   | block   | red   | DEEP-RED BLOCK              | refuse        | force    |
 *   | error   | red   | UNVERIFIED                  | refuse        | force    |
 *
 * GOLDEN RULE (C5): JavaScript NEVER decides "safe". Every function here READS an
 * engine-computed verdict tier (and engine-provided counts) and maps it to how it
 * LOOKS / what the default affordance is. There is:
 *   - NO severity scoring,
 *   - NO risk recomputation,
 *   - NO allowlist / regex / heuristic.
 * If the engine said `block`, this renders DEEP-RED BLOCK — it cannot upgrade a
 * verdict toward `allow`, and `error` (a failed/missing/timed-out scanner) is
 * rendered as a fail-closed refuse, exactly like `block`.
 *
 * RECONCILIATION with @prometheus/ui tokens.ts: the UI owns the role→hex token
 * (VERDICT_ROLE: allow=ok · warn=warn · block/error=danger). This module names
 * the SAME roles via `ColorRole` ("ok" | "warn" | "danger") so the two never
 * contradict — core decides the semantic role, ui paints it. We do NOT import ui
 * here (core must not depend on ui); the role union is a structural mirror, kept
 * in lock-step with tokens.ts's VERDICT_ROLE by verdictMapping.test.ts.
 */

import type { NemesisSeverity, SeverityCounts, VerdictTier } from "@prometheus/engine-bridge";

/**
 * The semantic color role a verdict maps to. These are EXACTLY the role-token
 * names @prometheus/ui's `VERDICT_ROLE` resolves to a themeable hex — keep them
 * in sync (the test pins allow→ok / warn→warn / block→danger / error→danger).
 */
export type ColorRole = "ok" | "warn" | "danger";

/** What the GUI does by default when it receives this verdict (no user input). */
export type DefaultAction = "proceed" | "hold" | "refuse";

/** The override affordance the GUI offers (if any) to get past this verdict. */
export type OverrideAffordance = "none" | "install-anyway" | "force";

/** The full display descriptor for one verdict tier (§3). */
export interface VerdictDisplay {
  /** the semantic color role (maps to a ui token, never a raw hex here). */
  color: ColorRole;
  /** the UPPERCASE headline label shown on the verdict sheet/badge. */
  label: string;
  /** what happens with NO further user action. */
  defaultAction: DefaultAction;
  /** the escape hatch the UI may surface (gated behind friction per §5.2/§5.3). */
  override: OverrideAffordance;
}

/**
 * The §3 table — the SINGLE verdict→display map. Frozen so a caller can never
 * mutate the canonical mapping at runtime.
 *
 *   allow → green  "SAFE — no known threats found"  proceed   (no override)
 *   warn  → amber  "REVIEW"                          hold      (install-anyway)
 *   block → red    "DEEP-RED BLOCK"                  refuse    (force)
 *   error → red    "UNVERIFIED"                      refuse    (force)
 *
 * NB the `allow` label is the engine's honest framing (§11): "SAFE — no known
 * threats found", never a bare "Safe". `error` is the fail-closed UNVERIFIED
 * state (scanner failed / missing / timeout), rendered identically to a block.
 */
export const VERDICT_DISPLAY: Readonly<Record<VerdictTier, Readonly<VerdictDisplay>>> =
  Object.freeze({
    allow: Object.freeze({
      color: "ok",
      label: "SAFE — no known threats found",
      defaultAction: "proceed",
      override: "none",
    }),
    warn: Object.freeze({
      color: "warn",
      label: "REVIEW",
      defaultAction: "hold",
      override: "install-anyway",
    }),
    block: Object.freeze({
      color: "danger",
      label: "DEEP-RED BLOCK",
      defaultAction: "refuse",
      override: "force",
    }),
    error: Object.freeze({
      color: "danger",
      label: "UNVERIFIED",
      defaultAction: "refuse",
      override: "force",
    }),
  });

/**
 * Map a verdict tier to its display descriptor. PURE: a lookup, no scoring. An
 * UNKNOWN/garbage tier (should never happen — VerdictTier is closed) fails closed
 * to the `error` (UNVERIFIED, refuse) descriptor, never to `allow`.
 */
export function verdictDisplay(tier: VerdictTier): VerdictDisplay {
  return VERDICT_DISPLAY[tier] ?? VERDICT_DISPLAY.error;
}

/** The color role for a tier (thin accessor over the map). */
export function verdictColor(tier: VerdictTier): ColorRole {
  return verdictDisplay(tier).color;
}

/** The headline label for a tier. */
export function verdictLabel(tier: VerdictTier): string {
  return verdictDisplay(tier).label;
}

/** The default (no-user-input) action for a tier. */
export function verdictDefaultAction(tier: VerdictTier): DefaultAction {
  return verdictDisplay(tier).defaultAction;
}

/** The override affordance the UI may surface for a tier. */
export function verdictOverride(tier: VerdictTier): OverrideAffordance {
  return verdictDisplay(tier).override;
}

/**
 * Does this tier halt by default (block/error), as opposed to proceed (allow) or
 * hold-for-review (warn)? Pure projection of `defaultAction === "refuse"`.
 */
export function isRefusedByDefault(tier: VerdictTier): boolean {
  return verdictDisplay(tier).defaultAction === "refuse";
}

/**
 * The minimal counts shape needsExplicitApproval reads. We accept the full
 * engine `SeverityCounts` OR a partial (any missing key reads as 0), so a caller
 * can pass a raw verdict's `severity_counts` straight through.
 */
export type ApprovalCounts = Partial<Record<NemesisSeverity, number>>;

/** Read a severity count, treating a missing/NaN value as 0 (fail toward warning). */
function count(counts: ApprovalCounts | undefined, sev: NemesisSeverity): number {
  const n = counts?.[sev];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Does a WARN verdict require an EXPLICIT user approval (the §5.2 checkbox-gated
 * "Install anyway"), versus a soft hold the user can clear with one click?
 *
 * The rule, read ONLY from engine-provided severity counts (§3 / §5.2):
 *   - a WARN with any CRITICAL or HIGH finding ⇒ require explicit approval;
 *   - under STRICT policy, a MEDIUM also requires explicit approval;
 *   - block / error ALWAYS require explicit handling (the Force flow) — true;
 *   - allow never does — false.
 *
 * This NEVER scores or recomputes risk — it only counts the buckets the engine
 * already classified. `strict` reflects the policy the engine ran under (the
 * caller passes the verdict's own policy tier), it does not re-derive severity.
 */
export function needsExplicitApproval(
  tier: VerdictTier,
  counts: ApprovalCounts | undefined,
  opts: { strict?: boolean } = {},
): boolean {
  // block / error are never auto-cleared — the UI must run the Force flow.
  if (tier === "block" || tier === "error") return true;
  // allow needs nothing.
  if (tier === "allow") return false;
  // warn: serious findings (CRIT/HIGH, or MEDIUM under strict) gate the action.
  const serious = count(counts, "CRITICAL") + count(counts, "HIGH");
  if (serious > 0) return true;
  if (opts.strict && count(counts, "MEDIUM") > 0) return true;
  return false;
}
