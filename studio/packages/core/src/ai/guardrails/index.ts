/**
 * ai/guardrails — the metered-spend control subsystem (file 12 §4): cost estimation,
 * the pre-call enforcement decision, the live meter fold + monthly reset, and the
 * spend-meter view-model. Pure; `now` is always injected.
 */
export {
  type GuardrailAction,
  type GuardrailDecision,
  type TokenUsage,
  enforceGuardrail,
  estimateCost,
  nextMonthIso,
  recordSpend,
  resetIfDue,
} from "./costGuardrail.js";
export { type SpendMeterView, spendBar, spendMeterView } from "./spendMeter.js";
export {
  type BudgetAction,
  type BudgetConfig,
  type BudgetDecision,
  type BudgetWindow,
  type PriceFor,
  type SpendRecord,
  type SpendSummary,
  evaluateBudgets,
  summarizeSpend,
} from "./budgetWindows.js";
/**
 * The shared pre-turn spend gate. Every host that can spend money calls THIS — see the
 * module header for why `enforceGuardrail`/`evaluateGuardrail` are not composed into it.
 */
export {
  type BudgetGateInput,
  type BudgetGateResult,
  decideBudget,
  hasBudgetCap,
  mergeDayRecords,
  startOfLocalDayMs,
} from "./budgetGate.js";
export {
  type SpendLedgerRecord,
  appendSharedSpend,
  dayFileName as sharedDayFileName,
  parseLedger as parseSpendLedger,
  readSharedDay,
  sharedAccountingDir,
  sharedDayFile,
} from "./spend-ledger.js";
