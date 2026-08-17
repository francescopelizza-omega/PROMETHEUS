/**
 * ai/guardrails/budgetGate.ts — the SHARED pre-turn spend gate (one per host, not three).
 *
 * WHY THIS EXISTS. There were three spend-cap implementations in this repo and only one of
 * them ever ran:
 *
 *   · `costGuardrail.enforceGuardrail`   — monthly ceiling. ZERO production callers.
 *   · `providers/guardrails.evaluateGuardrail` — cap/warn/auto-disable. ZERO production callers.
 *   · the CLI's `checkBudgetGate`        — the only one wired to anything, and it blocks.
 *
 * Two of the three were unit-tested against fakes and never called, which is exactly how a
 * user comes to believe a cap is protecting them when it is decoration. The desktop had none
 * of the three: `AgentPane` renders a `SpendMeter` with a `capUsd` read from localStorage and
 * nothing anywhere consults it, so the cap was a LABEL.
 *
 * So the DECISION lives here, once, and each host supplies only what is genuinely host-shaped:
 * where the records are read from and what the clock says. `enforceGuardrail` and
 * `evaluateGuardrail` are deliberately NOT composed in — reviving two dead evaluators to sit
 * beside a live one would recreate the same problem with an extra layer. If a monthly window
 * is wanted it belongs in `evaluateBudgets` as a third window, not as a second engine.
 *
 * PURE: no fs, no clock, no network. `nowIso` and both record lists are passed in.
 */
import {
  type BudgetConfig,
  type BudgetDecision,
  type PriceFor,
  type SpendRecord,
  evaluateBudgets,
} from "./budgetWindows.js";

/** What the gate tells the host to do about the turn it is about to run. */
export interface BudgetGateResult {
  /** `block` MUST halt the turn before the next model call — never merely display a number. */
  action: "ok" | "warn" | "block";
  /** a human-readable line to surface; absent ⇒ nothing worth saying. */
  message?: string;
}

/** Everything the decision needs, with nothing host-shaped left in it. */
export interface BudgetGateInput {
  /** records for THIS session only — the session window sums every one of them. */
  sessionRecords: readonly SpendRecord[];
  /**
   * Records for the local calendar DAY, or undefined when no daily cap is configured.
   *
   * Separate from `sessionRecords` on purpose. `evaluateBudgets` sums the session window over
   * every record it is handed and only filters for the daily one, so passing one merged array
   * makes `session_usd` trip on the whole machine's day. They are evaluated over different
   * record sets and the more severe answer wins.
   */
  dayRecords?: readonly SpendRecord[];
  config: BudgetConfig;
  nowIso: string;
  priceFor: PriceFor;
  /**
   * Windows already warned about, MUTATED here (a warn is latched so a long session does not
   * repeat the same line every turn). The host owns the set's lifetime.
   */
  warned: Set<string>;
  /** the explicit user override (`--force-budget`): downgrade a block to a noisy proceed. */
  forceBudget?: boolean;
}

/** Rank a budget decision by how much it restricts. block > warn > ok. */
const DECISION_RANK: Readonly<Record<string, number>> = Object.freeze({ ok: 0, warn: 1, block: 2 });

/** The stricter of two window decisions — a cap is a floor across windows, not an average. */
function moreSevere(a: BudgetDecision, b: BudgetDecision): BudgetDecision {
  return (DECISION_RANK[b.action] ?? 0) > (DECISION_RANK[a.action] ?? 0) ? b : a;
}

/** Local midnight for the day `nowIso` falls in, as epoch ms. Mirrors budgetWindows' day key. */
export function startOfLocalDayMs(nowIso: string): number {
  const d = new Date(nowIso);
  if (Number.isNaN(d.getTime())) return 0; // unparseable clock ⇒ read every file rather than none
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Union the session's records with the day's, without double-counting.
 *
 * The current session's file is one of the day's files, so it appears in both lists. Records
 * carry no id, so identity is the tuple that makes one unique in practice: the timestamp, the
 * model and the two token counts. A collision would have to be the same model billing the same
 * token counts in the same millisecond.
 */
export function mergeDayRecords(
  session: readonly SpendRecord[],
  day: readonly SpendRecord[],
): SpendRecord[] {
  const seen = new Set<string>();
  const out: SpendRecord[] = [];
  for (const r of [...session, ...day]) {
    const key = `${r.atIso}|${r.model}|${r.promptTokens}|${r.completionTokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Decide whether the next metered turn may fire.
 *
 * FAIL-CLOSED, like nemesis: if the records cannot be evaluated at all, the turn is BLOCKED
 * unless `forceBudget` is set. That half is load-bearing and easy to lose — it only works
 * because the host's reader THROWS on an unreadable store rather than returning `[]`. A
 * store that read as "$0 spent" when it was deleted or chmod-000 would invert the documented
 * guarantee into a one-command bypass. A store that was never written is still `[]`, because
 * that is the normal first run.
 */
export function decideBudget(input: BudgetGateInput): BudgetGateResult {
  const { config, nowIso, priceFor, warned } = input;
  let decision: BudgetDecision;
  try {
    // The SESSION window sees only this session; a fresh session id is minted per launch, so
    // handing it the day's records would make `session_usd` trip on the whole machine's day.
    const sessionOnly: BudgetConfig = {
      ...(config.sessionUsd !== undefined ? { sessionUsd: config.sessionUsd } : {}),
      ...(config.warnAtPercent !== undefined ? { warnAtPercent: config.warnAtPercent } : {}),
      ...(config.unpricedPolicy !== undefined ? { unpricedPolicy: config.unpricedPolicy } : {}),
    };
    decision = evaluateBudgets(input.sessionRecords, sessionOnly, nowIso, priceFor);
    if (config.dailyUsd !== undefined) {
      // The DAILY window must see the whole day, or quitting and reopening resets the cap and
      // a user can spend N times it by restarting.
      const dayRecords = mergeDayRecords(input.sessionRecords, input.dayRecords ?? []);
      const daily = evaluateBudgets(
        dayRecords,
        {
          dailyUsd: config.dailyUsd,
          ...(config.warnAtPercent !== undefined ? { warnAtPercent: config.warnAtPercent } : {}),
          ...(config.unpricedPolicy !== undefined ? { unpricedPolicy: config.unpricedPolicy } : {}),
        },
        nowIso,
        priceFor,
      );
      decision = moreSevere(decision, daily);
    }
  } catch (e) {
    if (input.forceBudget) return { action: "ok" };
    return {
      action: "block",
      message: `budget check failed (fail-closed block): ${(e as Error).message}. Use --force-budget to override.`,
    };
  }

  if (decision.action === "block") {
    if (input.forceBudget) {
      return {
        action: "ok",
        message: `⚠ over ${decision.window} budget ($${decision.spentUsd.toFixed(2)}/$${decision.capUsd.toFixed(2)}) — proceeding (--force-budget)`,
      };
    }
    return {
      action: "block",
      message: `budget hard-stop — ${decision.reason}. Use --force-budget to override this run.`,
    };
  }
  if (decision.action === "warn") {
    // Latched per window: a long session should say this once, not once per turn.
    const key = decision.window ?? "session";
    if (warned.has(key)) return { action: "ok" };
    warned.add(key);
    return { action: "warn", message: `⚠ ${decision.reason}` };
  }
  return { action: "ok" };
}

/**
 * Does this budget config actually cap anything?
 *
 * A config with no window is not a cap, and a host that treats it as one pays for a record
 * read on every single turn to reach a foregone `ok`.
 */
export function hasBudgetCap(config: BudgetConfig | undefined): boolean {
  return !!config && (config.sessionUsd !== undefined || config.dailyUsd !== undefined);
}
