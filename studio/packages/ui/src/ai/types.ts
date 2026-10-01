// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/types.ts — the AI-Providers screen's LOCAL view shapes + pure projections (file 12 §4/§5).
 *
 * `@prometheus/ui` has NO project reference to `@prometheus/core` (the renderer wires
 * the two; the design system stays standalone — see security/types.ts, modelhub/
 * types.ts). So this file RE-DECLARES the slim, structurally-compatible shapes the
 * screen renders, and owns the PURE projections the components + tests use:
 *  - the promotion sort (A>B>C, open-weight first) — §5;
 *  - the §4.1 warn-modal copy + the typed-confirm predicate;
 *  - the §4.3 spend-meter view-model.
 *
 * No hex, no rendering here — color is carried as a semantic ROLE token name the
 * components resolve via var(--<role>) (08 §6/§7).
 */
import type { CostTier } from "../components/CostLight.js";

/** Re-export the tier type so the screen imports tiers from one place. */
export type { CostTier } from "../components/CostLight.js";

/** How loudly a provider must warn (file 12 §0). "loud" ⇒ the blocking typed-confirm. */
export type WarnLevel = "none" | "gentle" | "loud";

/** One connector wiring offered for a provider (decides the effective tier + light). */
export type WiringKind =
  | "local-serve"
  | "oauth-subscription-bridge"
  | "cli-passthrough"
  | "api-key";

/** A row in the AI-Providers screen (one provider × the wiring being shown). §5.1. */
export interface AiProviderRow {
  id: string;
  label: string;
  /** the EFFECTIVE tier for the shown wiring (A local · B subscription · C metered). */
  tier: CostTier;
  kind: WiringKind;
  warnLevel: WarnLevel;
  /** the short billing/status caption (e.g. "subscription-included", "metered"). */
  caption: string;
  /** open-weight models sort first within a tier (§5 / [[05]] §6). */
  openWeight?: boolean;
  /** the model id shown for this row, if any. */
  modelId?: string;
  /** Tier-B providers that need a ToS coverage check render the verifyAtSetup footnote. */
  verifyAtSetup?: boolean;
  /** a metered open-weight row offers the §6 "run it locally" escape hatch. */
  repointSuggest?: boolean;
  /** deep-link to the provider's ToS (cloud rows). */
  tosUrl?: string;
}

const TIER_RANK: Record<CostTier, number> = { A: 0, B: 1, C: 2 };

/** Promotion sort: A→B→C; within a tier, open-weight first, then by label (§5). */
export function sortProviderRows(rows: readonly AiProviderRow[]): AiProviderRow[] {
  return [...rows].sort((a, b) => {
    const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (t !== 0) return t;
    const ow = Number(b.openWeight ?? false) - Number(a.openWeight ?? false);
    if (ow !== 0) return ow;
    return a.label.localeCompare(b.label);
  });
}

/** Group rows by tier in promotion order (for the §5.1 three-section layout). */
export function groupByTier(
  rows: readonly AiProviderRow[],
): { tier: CostTier; rows: AiProviderRow[] }[] {
  const sorted = sortProviderRows(rows);
  return (["A", "B", "C"] as CostTier[])
    .map((tier) => ({ tier, rows: sorted.filter((r) => r.tier === tier) }))
    .filter((g) => g.rows.length > 0);
}

/** The tier-section heading copy for the §5.1 wireframe. */
export const TIER_SECTION: Record<CostTier, { title: string; note: string }> = {
  A: {
    title: "TIER A · LOCAL OPEN-WEIGHT",
    note: "your hardware, $0, private, offline — ★ DEFAULT / PROMOTED",
  },
  B: {
    title: "TIER B · SUBSCRIPTION-INCLUDED",
    note: "bounded cost, usage rides a plan you already pay — PROMOTED 2nd",
  },
  C: {
    title: "TIER C · PAY-PER-USE METERED",
    note: "every token costs money; can escalate fast — ALLOWED, NOT PROMOTED",
  },
};

/* ── §4.1 the loud warn-modal copy + typed-confirm ─────────────────────────── */

/** The literal phrase the user must type to enable a metered (Tier-C) connector (§4.1). */
export const ENABLE_METERED_PHRASE = "ENABLE METERED";

export interface CostWarningInput {
  providerLabel: string;
  modelLabel?: string;
  /** "~$0.27 / 1M in · ~$1.10 / 1M out  (verify ToS)" — already formatted by the caller. */
  priceLine?: string;
  /** does this provider's model run free locally? drives the equal-weight escape-hatch CTA. */
  repointSuggest?: boolean;
}

/** The verbatim §4.1 copy, structured for rendering (one source for the modal + tests). */
export interface CostWarningCopy {
  title: string;
  body: string[];
  providerLine: string;
  modelLine?: string;
  billingLine: string;
  /** the loud, equal-weight free alternative (present iff the model can run locally). */
  localAltCta?: string;
  phrase: string;
  cancelLabel: string;
  confirmLabel: string;
}

/** Build the §4.1 warn copy (verbatim sentences; dynamic provider/model lines). */
export function costWarningCopy(input: CostWarningInput): CostWarningCopy {
  return {
    title: "⚠  PAY-PER-USE SERVICE — costs can grow VERY quickly",
    body: [
      "You are configuring a PAY-PER-USE service (metered API billing).",
      "Every prompt and every token your agents send to this provider COSTS MONEY. An autonomous agent loop or a large context can run up a bill surprisingly fast.",
    ],
    providerLine: `Provider:  ${input.providerLabel}`,
    ...(input.modelLabel
      ? {
          modelLine: `Model:     ${input.modelLabel}${input.priceLine ? `   ${input.priceLine}` : ""}`,
        }
      : {}),
    billingLine: "Billing:   METERED — not covered by any subscription.",
    ...(input.repointSuggest ? { localAltCta: "Use a local model instead →  (recommended)" } : {}),
    phrase: ENABLE_METERED_PHRASE,
    cancelLabel: "Cancel",
    confirmLabel: "Enable metered service",
  };
}

/**
 * §4.1 typed-confirm predicate — the confirm button is enabled ONLY when the user
 * typed the EXACT phrase AND a positive monthly cap is set. Trim is intentional: a
 * trailing space must not silently pass (mirrors the engine's exact-match force token).
 */
export function confirmEnabled(typed: string, monthlyCapUsd: number): boolean {
  return typed === ENABLE_METERED_PHRASE && monthlyCapUsd > 0;
}

/* ── §4.3 the live spend meter view-model ──────────────────────────────────── */

export interface SpendMeterModel {
  spentUsd: number;
  capUsd: number;
  /** clamped [0,1] for the fill bar width. */
  fraction: number;
  /** raw spent/cap (may exceed 1 when over). */
  rawFraction: number;
  pctLabel: string;
  /** "$4.20 / $20.00 · 21%" */
  line: string;
  band: "ok" | "warn" | "over";
  /** the semantic role token name the bar fills with (ok→--ok, warn→--warn, over→--danger). */
  role: "ok" | "warn" | "danger";
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Build the §4.3 meter view-model from live spend + the cap + the warn threshold. */
export function spendMeterModel(
  spentUsd: number,
  capUsd: number,
  warnAtPct = 0.8,
): SpendMeterModel {
  const rawFraction = capUsd > 0 ? spentUsd / capUsd : 0;
  const fraction = Math.max(0, Math.min(1, rawFraction));
  const pct = Math.round(rawFraction * 100);
  const band: SpendMeterModel["band"] =
    rawFraction >= 1 ? "over" : rawFraction >= warnAtPct ? "warn" : "ok";
  const role = band === "over" ? "danger" : band === "warn" ? "warn" : "ok";
  return {
    spentUsd,
    capUsd,
    fraction,
    rawFraction,
    pctLabel: `${pct}%`,
    line: `${fmtUsd(spentUsd)} / ${fmtUsd(capUsd)} · ${pct}%`,
    band,
    role,
  };
}

/** A text fill bar (e.g. "▓▓▓░░░░░░░"), §4.3/§5.1. Pure; clamps to [0,1]. */
export function spendBarText(fraction: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return "▓".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}
