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
  evaluateBudgets,
} from "./budgetWindows.js";
