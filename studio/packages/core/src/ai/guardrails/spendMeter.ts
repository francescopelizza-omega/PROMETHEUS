// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/guardrails/spendMeter.ts — the live spend meter view-model (file 12 §4.3).
 *
 * Pure formatting for the "$3.20 / $20.00 · 16%" meter line + the proportional fill
 * bar shown beside any metered connector. No rendering here (UI owns pixels); this
 * just turns a CostGuardrail into the strings + ratios the SpendMeter component draws.
 */
import type { CostGuardrail } from "../providers/types.js";

/** The view-model for the spend meter (§4.3). */
export interface SpendMeterView {
  spentUsd: number;
  capUsd: number;
  /** spent / cap, clamped to [0, 1] for the bar width. */
  fraction: number;
  /** raw spent / cap (may exceed 1 when over cap). */
  rawFraction: number;
  pctLabel: string;
  line: string;
  /** the band the meter is in — drives the token color (green/amber/red). */
  band: "ok" | "warn" | "over";
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Build the meter view-model from a guardrail. */
export function spendMeterView(guardrail: CostGuardrail): SpendMeterView {
  const cap = guardrail.monthlyCapUsd;
  const spent = guardrail.spentThisMonthUsd;
  const rawFraction = cap > 0 ? spent / cap : 0;
  const fraction = Math.max(0, Math.min(1, rawFraction));
  const pct = Math.round(rawFraction * 100);
  const band: SpendMeterView["band"] =
    rawFraction >= 1 ? "over" : rawFraction >= guardrail.warnAtPct ? "warn" : "ok";
  return {
    spentUsd: spent,
    capUsd: cap,
    fraction,
    rawFraction,
    pctLabel: `${pct}%`,
    line: `${fmtUsd(spent)} / ${fmtUsd(cap)} · ${pct}%`,
    band,
  };
}

/**
 * A text fill bar for the CLI/meter (e.g. "████░░░░░░"). `width` cells; filled to the
 * clamped fraction. Pure — the GUI uses `fraction` directly for a pixel bar instead.
 */
export function spendBar(fraction: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}
