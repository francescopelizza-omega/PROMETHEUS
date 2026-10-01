// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/guardrails/costGuardrail.ts — the metered-spend control subsystem (file 12 §4).
 *
 * A Tier-C (api-key/metered) connector MUST carry a CostGuardrail. This module is the
 * pure engine behind it:
 *  - `estimateCost` — USD for a call from token counts + the model's per-Mtok prices;
 *  - `enforceGuardrail` (§4.2) — the decision BEFORE a call fires: per-request ceiling,
 *    then projected monthly spend vs the cap (honoring `onCap`), then the warn band;
 *  - `recordSpend` — fold a call's actual cost into the live meter;
 *  - `resetIfDue` — roll the meter over at the monthly boundary.
 *
 * All functions are pure: `now` is passed in (never read from the clock) so the policy
 * is deterministic + testable. Money is never silently spent — a block is a hard stop.
 */
import type { CostGuardrail, ModelEntry } from "../providers/types.js";

/** Token usage for one call (estimated before, actual after). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Estimate the USD cost of a call. Free/subscription models (null price) cost $0. */
export function estimateCost(
  usage: TokenUsage,
  model: Pick<ModelEntry, "pricePerMTokIn" | "pricePerMTokOut">,
): number {
  const inPrice = model.pricePerMTokIn ?? 0;
  const outPrice = model.pricePerMTokOut ?? 0;
  const cost =
    (usage.inputTokens / 1_000_000) * inPrice + (usage.outputTokens / 1_000_000) * outPrice;
  return cost > 0 ? cost : 0;
}

/** The action a guardrail decision dictates. */
export type GuardrailAction = "ok" | "warn" | "block" | "auto-disable";

/** The decision returned BEFORE a metered call fires (§4.2). */
export interface GuardrailDecision {
  /** may the call proceed? false ⇒ the request must NOT be sent. */
  allow: boolean;
  action: GuardrailAction;
  reason: string;
  /** projected spend this month if the call proceeds (spent + estimate). */
  projectedUsd: number;
  /** fraction of the monthly cap already spent (0..1+, before this call). */
  fractionUsed: number;
}

/**
 * §4.2 enforcement — decide whether a metered call may fire, given its estimated cost.
 * Order: (1) per-request ceiling → block; (2) projected monthly > cap → honor `onCap`
 * (auto-disable | block-new = block; warn-only = allow+warn); (3) already past the warn
 * band → allow+warn; else ok. Never mutates the guardrail.
 */
export function enforceGuardrail(guardrail: CostGuardrail, estimateUsd: number): GuardrailDecision {
  const cap = guardrail.monthlyCapUsd;
  const spent = guardrail.spentThisMonthUsd;
  const projectedUsd = spent + estimateUsd;
  const fractionUsed = cap > 0 ? spent / cap : 0;

  if (guardrail.perRequestMaxUsd !== undefined && estimateUsd > guardrail.perRequestMaxUsd) {
    return {
      allow: false,
      action: "block",
      reason: `estimated $${estimateUsd.toFixed(2)} exceeds the per-request limit of $${guardrail.perRequestMaxUsd.toFixed(2)}`,
      projectedUsd,
      fractionUsed,
    };
  }

  if (cap > 0 && projectedUsd > cap) {
    if (guardrail.onCap === "warn-only") {
      return {
        allow: true,
        action: "warn",
        reason: `projected $${projectedUsd.toFixed(2)} exceeds the $${cap.toFixed(2)} monthly cap (warn-only)`,
        projectedUsd,
        fractionUsed,
      };
    }
    const action: GuardrailAction = guardrail.onCap === "auto-disable" ? "auto-disable" : "block";
    return {
      allow: false,
      action,
      reason: `projected $${projectedUsd.toFixed(2)} would exceed the $${cap.toFixed(2)} monthly cap`,
      projectedUsd,
      fractionUsed,
    };
  }

  if (cap > 0 && fractionUsed >= guardrail.warnAtPct) {
    return {
      allow: true,
      action: "warn",
      reason: `at ${(fractionUsed * 100).toFixed(0)}% of the $${cap.toFixed(2)} monthly cap`,
      projectedUsd,
      fractionUsed,
    };
  }

  return { allow: true, action: "ok", reason: "within budget", projectedUsd, fractionUsed };
}

/**
 * Fold a call's actual cost into the meter (§4.3). Returns a NEW guardrail (immutable);
 * also stamps `lastEstimateUsd`. The caller persists the result.
 */
export function recordSpend(guardrail: CostGuardrail, actualUsd: number): CostGuardrail {
  const add = actualUsd > 0 ? actualUsd : 0;
  return {
    ...guardrail,
    spentThisMonthUsd: guardrail.spentThisMonthUsd + add,
    lastEstimateUsd: add,
  };
}

/**
 * Roll the meter over when the reset date has passed (§4). `nowIso` is the current
 * instant; if it is >= `resetsOn`, spend resets to 0 and `resetsOn` advances one
 * calendar month. Returns a NEW guardrail (or the same object when not yet due).
 */
export function resetIfDue(guardrail: CostGuardrail, nowIso: string): CostGuardrail {
  const now = Date.parse(nowIso);
  const due = Date.parse(guardrail.resetsOn);
  if (!Number.isFinite(now) || !Number.isFinite(due) || now < due) return guardrail;
  return {
    ...guardrail,
    spentThisMonthUsd: 0,
    resetsOn: nextMonthIso(guardrail.resetsOn),
    lastEstimateUsd: 0,
  };
}

/** Advance an ISO date by one calendar month (UTC), preserving the day-of-month best-effort. */
export function nextMonthIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  // clamp the day to the target month's length (e.g. Jan 31 → Feb 28/29)
  const lastDayNext = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  const next = new Date(
    Date.UTC(
      year,
      month + 1,
      Math.min(day, lastDayNext),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ),
  );
  return next.toISOString();
}
