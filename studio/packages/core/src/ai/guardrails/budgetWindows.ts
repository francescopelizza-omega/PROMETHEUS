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
  /**
   * What to do when a metered model has NO price entry: `"block"` (the default, fail-closed)
   * or `"warn"` — an explicit opt-in to spend uncapped on that model.
   *
   * Thirteen of the eighteen cloud providers this CLI can select have no price, and an
   * unpriced record used to contribute exactly $0. So a `session_usd = 1` cap let a
   * 200-million-token Groq session through reporting `spentUsd: 0`, while the same record on
   * Claude blocked at $1800. A cap that silently does not apply is worse than no cap: the
   * user believes they are protected. There is no token→USD conversion for a model we have no
   * rate for, so counting tokens instead would enforce a number the user never chose.
   */
  unpricedPolicy?: "block" | "warn";
}

export type BudgetAction = "ok" | "warn" | "block";
export type BudgetWindow = "session" | "daily";

export interface BudgetDecision {
  action: BudgetAction;
  window?: BudgetWindow;
  spentUsd: number;
  capUsd: number;
  reason?: string;
  /** what triggered the decision: a cap window, or a model that cannot be priced at all. */
  cause?: BudgetWindow | "unpriced";
  /** distinct model ids with no price — their spend is NOT included in `spentUsd`. */
  unpriced?: string[];
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

/** `null` ⇒ this model has NO price, which is not the same fact as "it cost nothing". */
function recordUsd(r: SpendRecord, priceFor: PriceFor): number | null {
  const price = priceFor(r.model);
  // Absent, or present with both rates null (a local/free row) — the first is ignorance, the
  // second is a real zero, and conflating them is what made the cap silently inapplicable.
  if (!price) return null;
  if (price.pricePerMTokIn == null && price.pricePerMTokOut == null) return 0;
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
  const unpriced = new Set<string>();
  for (const r of records) {
    const usd = recordUsd(r, priceFor);
    if (usd === null) {
      unpriced.add(r.model);
      continue;
    }
    sessionSpent += usd;
    if (localDayKey(r.atIso) === today) dailySpent += usd;
  }
  /**
   * A cap is in force and something in this session cannot be priced ⇒ FAIL CLOSED.
   *
   * Only reached when the user actually set a cap: with no `[budget]` table the guard is not
   * consulted at all, so nothing changes for anyone who did not ask for the guarantee. The
   * escapes are explicit — `--force-budget` for one run, `unpriced_policy = "warn"` to stand
   * it down permanently.
   */
  const capped = (cfg.sessionUsd ?? 0) > 0 || (cfg.dailyUsd ?? 0) > 0;
  if (capped && unpriced.size > 0 && cfg.unpricedPolicy !== "warn") {
    const names = [...unpriced].sort();
    return {
      action: "block",
      cause: "unpriced",
      unpriced: names,
      spentUsd: sessionSpent,
      capUsd: cfg.sessionUsd ?? cfg.dailyUsd ?? 0,
      reason: `no price is known for ${names.join(", ")}, so a USD cap cannot be enforced for it — re-run with --force-budget, or set budget.unpriced_policy = "warn" to allow uncapped spend on unpriced models`,
    };
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
