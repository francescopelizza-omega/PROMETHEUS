// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * providers/guardrails.ts — CostGuardrail evaluation (C11).
 *
 * A pure, side-effect-free evaluator the Studio MAIN process (and the GUI)
 * consult for any metered (Tier-C) provider: how much budget is left, are we
 * over a soft alert threshold, and must we auto-disable the provider now.
 *
 * This module DECIDES NOTHING about security (that is nemesis/engine-bridge);
 * it only governs SPEND. It is intentionally trivial and total — no I/O, no
 * deps — so it is trivially testable and safe to call on every token tick.
 */
import type { CostGuardrail } from "../domain/models.js";

/** The computed state of a guardrail at a point in time. */
export interface GuardrailEvaluation {
  providerId: string;
  budgetCap: number;
  spent: number;
  /** clamped to >= 0; budgetCap - spent. */
  remaining: number;
  /** spent / budgetCap, clamped to [0, +inf) (>1 means over cap). */
  fractionUsed: number;
  currency: string;
  /** spent >= budgetCap. */
  overCap: boolean;
  /** crossed the soft warn threshold (if configured) but not yet over cap. */
  warning: boolean;
  /** the supervisor MUST disable the provider now (overCap && autoDisableAtCap). */
  shouldAutoDisable: boolean;
}

/** Coerce a possibly-bad number to a finite, non-negative value. */
function nonNeg(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Evaluate a CostGuardrail. Total over all inputs (negative/NaN/Infinity are
 * coerced to safe values). A zero/absent budgetCap is treated as "no budget"
 * => always over cap (fail-closed on spend: an unconfigured cap blocks rather
 * than silently allowing unbounded metered spend).
 */
export function evaluateGuardrail(g: CostGuardrail): GuardrailEvaluation {
  const budgetCap = nonNeg(g.budgetCap);
  const spent = nonNeg(g.spent);
  const currency = g.currency ?? "USD";
  const remaining = Math.max(0, budgetCap - spent);

  // No (or zero) cap => treat as exhausted: spend is not authorised.
  const overCap = budgetCap <= 0 ? spent > 0 || budgetCap <= 0 : spent >= budgetCap;

  const fractionUsed = budgetCap > 0 ? spent / budgetCap : spent > 0 ? Number.POSITIVE_INFINITY : 1;

  const warnFraction =
    typeof g.warnAtFraction === "number" && g.warnAtFraction > 0 && g.warnAtFraction <= 1
      ? g.warnAtFraction
      : undefined;

  const warning = !overCap && warnFraction !== undefined && fractionUsed >= warnFraction;

  // autoDisableAtCap defaults to TRUE for a Tier-C guardrail (fail-closed spend):
  // an explicit `false` is required to keep a metered provider running past cap.
  const autoDisable = g.autoDisableAtCap !== false;
  const shouldAutoDisable = overCap && autoDisable;

  return {
    providerId: g.providerId,
    budgetCap,
    spent,
    remaining,
    fractionUsed,
    currency,
    overCap,
    warning,
    shouldAutoDisable,
  };
}

/** Record additional spend against a guardrail, returning a NEW guardrail. */
export function recordSpend(g: CostGuardrail, amount: number): CostGuardrail {
  const add = nonNeg(amount);
  return { ...g, spent: nonNeg(g.spent) + add };
}

/**
 * A human-renderable, one-line summary of a guardrail's state — used by the CLI
 * and as the body of the GUI's CostGuardrail badge.
 */
export function describeGuardrail(ev: GuardrailEvaluation): string {
  const pct = Number.isFinite(ev.fractionUsed) ? `${Math.round(ev.fractionUsed * 100)}%` : "over";
  const head = `${ev.providerId}: ${ev.currency} ${ev.spent.toFixed(2)} / ${ev.budgetCap.toFixed(2)} (${pct})`;
  if (ev.shouldAutoDisable) return `${head} — CAP REACHED, auto-disabling`;
  if (ev.overCap) return `${head} — OVER CAP`;
  if (ev.warning) return `${head} — approaching cap`;
  return `${head} — ${ev.currency} ${ev.remaining.toFixed(2)} remaining`;
}
