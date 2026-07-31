/**
 * ai/guardrails/budgetWindows.ts — session + daily USD budget windows (CLI-030).
 *
 * COMPOSES WITH (never replaces) the monthly `enforceGuardrail`: a metered turn blocks if
 * monthly OR session OR daily says block. PURE — records + `nowIso` + a price lookup are
 * passed in (no fs, no `Date.now()`); the CLI side owns reading the CLI-029 accounting store
 * and latching the once-per-window warn. Spend comes ONLY from CLI-029 records → `estimateCost`;
 * this never re-derives token counts. `estimated:true` rows count as a conservative spend FLOOR.
 */
import { type TokenUsage, estimateCost } from "./costGuardrail.js";

/** The subset of a CLI-029 AccountingRecord this evaluator needs. */
export interface SpendRecord {
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
  atIso: string;
}

export interface BudgetConfig {
  /** cap for the whole session (all records). Absent/<=0 ⇒ no session limit. */
  sessionUsd?: number;
  /** cap for the local calendar day. Absent/<=0 ⇒ no daily limit. */
  dailyUsd?: number;
  /** warn when spend crosses this % of a cap (default 80). */
  warnAtPercent?: number;
}

export type BudgetAction = "ok" | "warn" | "block";
export type BudgetWindow = "session" | "daily";

export interface BudgetDecision {
  action: BudgetAction;
  window?: BudgetWindow;
  spentUsd: number;
  capUsd: number;
  reason?: string;
}

/** Model → per-MTok price (null/absent ⇒ free/local ⇒ $0). */
export type PriceFor = (
  model: string,
) => { pricePerMTokIn?: number | null; pricePerMTokOut?: number | null } | undefined;

/** LOCAL calendar-day bucket key (NOT a UTC ISO slice — respects the user's midnight/DST). */
function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "invalid";
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function recordUsd(r: SpendRecord, priceFor: PriceFor): number {
  const price = priceFor(r.model);
  if (!price) return 0; // unknown/local model → $0 (never counts toward a metered cap)
  const usage: TokenUsage = { inputTokens: r.promptTokens, outputTokens: r.completionTokens };
  return estimateCost(usage, {
    pricePerMTokIn: price.pricePerMTokIn ?? null,
    pricePerMTokOut: price.pricePerMTokOut ?? null,
  });
}

/**
 * Decide whether the NEXT metered turn may fire, given the session's accounting records.
 * Returns the MOST SEVERE window decision (block > warn > ok). A block names the window,
 * spend, and cap. Pure — the caller latches the warn and owns the local-turn bypass.
 */
export function evaluateBudgets(
  records: readonly SpendRecord[],
  cfg: BudgetConfig,
  nowIso: string,
  priceFor: PriceFor,
): BudgetDecision {
  const warnFrac = Math.min(1, Math.max(0, (cfg.warnAtPercent ?? 80) / 100));
  const today = localDayKey(nowIso);
  let sessionSpent = 0;
  let dailySpent = 0;
  for (const r of records) {
    const usd = recordUsd(r, priceFor);
    sessionSpent += usd;
    if (localDayKey(r.atIso) === today) dailySpent += usd;
  }
  const windows: { window: BudgetWindow; spent: number; cap?: number }[] = [
    { window: "session", spent: sessionSpent, cap: cfg.sessionUsd },
    { window: "daily", spent: dailySpent, cap: cfg.dailyUsd },
  ];
  let best: BudgetDecision = { action: "ok", spentUsd: sessionSpent, capUsd: cfg.sessionUsd ?? 0 };
  for (const w of windows) {
    if (w.cap === undefined || w.cap <= 0) continue;
    if (w.spent >= w.cap) {
      return {
        action: "block",
        window: w.window,
        spentUsd: w.spent,
        capUsd: w.cap,
        reason: `${w.window} budget exceeded: $${w.spent.toFixed(2)} ≥ $${w.cap.toFixed(2)} cap`,
      };
    }
    if (w.spent >= w.cap * warnFrac && best.action !== "block") {
      best = {
        action: "warn",
        window: w.window,
        spentUsd: w.spent,
        capUsd: w.cap,
        reason: `${w.window} budget ${Math.round((w.spent / w.cap) * 100)}% used: $${w.spent.toFixed(2)} of $${w.cap.toFixed(2)}`,
      };
    }
  }
  return best;
}
