/**
 * ai/usage-cost.ts — PURE per-session token + cost accumulator (APP-055).
 *
 * Folds each turn's TokenUsage (from ai-client's SSE `usage` parse) into running totals +
 * a USD cost. The cost formula mirrors core `ai.guardrails.estimateCost` (tokens/1e6 ×
 * per-Mtok price, input vs output priced separately). Prices are NEVER invented: the
 * caller passes the model's `{in,out}` price or null — a null price leaves cost UNKNOWN
 * (never $0.00). Local/free endpoints pass null and the UI renders tokens without a $.
 */
import type { TokenUsage } from "./ai-client.js";

/** Per-Mtok USD prices for a model (input vs output differ, often 3–5×). */
export interface ModelPrice {
  in: number;
  out: number;
}

/** USD cost of one call, or null when the price is unknown (mirrors estimateCost). */
export function estimateCostUsd(usage: TokenUsage, price: ModelPrice | null): number | null {
  if (!price) return null;
  const cost =
    (usage.inputTokens / 1_000_000) * price.in + (usage.outputTokens / 1_000_000) * price.out;
  return cost > 0 ? cost : 0;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** running USD cost of the priced turns; null until a priced turn arrives (unknown/free). */
  costUsd: number | null;
  turns: number;
  /** the last turn's token count (per-turn display). */
  lastTurnTokens: number;
}

export function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: null,
    turns: 0,
    lastTurnTokens: 0,
  };
}

/**
 * Fold one turn's usage into the totals. A turn with no usage (endpoint didn't report it)
 * still counts as a turn but adds no tokens. A non-null price accrues cost; a null price
 * leaves `costUsd` untouched (so an all-local session stays null → tokens-only display).
 */
export function accumulateUsage(
  totals: UsageTotals,
  usage: TokenUsage | undefined,
  price: ModelPrice | null,
): UsageTotals {
  const next: UsageTotals = {
    ...totals,
    turns: totals.turns + 1,
    lastTurnTokens: usage?.totalTokens ?? 0,
  };
  if (!usage) return next;
  next.inputTokens += usage.inputTokens;
  next.outputTokens += usage.outputTokens;
  next.totalTokens += usage.totalTokens;
  const c = estimateCostUsd(usage, price);
  if (c !== null) next.costUsd = (totals.costUsd ?? 0) + c;
  return next;
}
