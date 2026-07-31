/**
 * onboarding/onboarding-state.ts — the PURE first-run wizard step machine + persistence
 * (APP-064). React-free + node:test-able. The wizard component is orchestration over shipped
 * flows (detectBins / ollama / AI-Providers / useTheme); this owns only the step transitions,
 * the result shape, and the show-once localStorage flag.
 *
 * shouldShowWizard is deliberately conservative: it shows ONLY when the flag is ENTIRELY
 * absent. Any stored value — a real completion, `{skipped:true}`, or even a corrupt blob —
 * means "don't nag" (fail toward NOT re-showing), so clearing an unrelated key never re-nags
 * a returning user.
 */

export const ONBOARDING_KEY = "prometheus.onboarding.v1";

/** The wizard steps, in order. "done" is terminal. */
export type OnboardingStep = "welcome" | "interpreter" | "model" | "theme" | "tokens" | "done";

export const STEP_ORDER: readonly OnboardingStep[] = [
  "welcome",
  "interpreter",
  "model",
  "theme",
  "tokens",
  "done",
];

/** How the model step was answered. */
export type ModelChoice = "local" | "api" | "later";

/** The wizard's collected choices (persisted at completion/skip). */
export interface OnboardingResult {
  completed: boolean;
  skipped?: boolean;
  interpreter?: string;
  modelChoice?: ModelChoice;
  theme?: string;
  tokensOptIn?: boolean;
  ts?: number;
}

/** The next step after `step` (clamped at "done"). */
export function nextStep(step: OnboardingStep): OnboardingStep {
  const i = STEP_ORDER.indexOf(step);
  return STEP_ORDER[Math.min(STEP_ORDER.length - 1, i + 1)] ?? "done";
}

/** The previous step before `step` (clamped at "welcome"). */
export function prevStep(step: OnboardingStep): OnboardingStep {
  const i = STEP_ORDER.indexOf(step);
  return STEP_ORDER[Math.max(0, i - 1)] ?? "welcome";
}

export function isTerminal(step: OnboardingStep): boolean {
  return step === "done";
}

/**
 * Show the wizard ONLY when the flag is absent (`raw === null`). A parseable value OR a
 * corrupt one both mean "already handled" → don't show.
 */
export function shouldShowWizard(raw: string | null | undefined): boolean {
  return raw === null || raw === undefined;
}

/** Load a stored result (for the tokens/model choices), fail-soft → a completed default. */
export function loadOnboarding(raw: string | null | undefined): OnboardingResult {
  if (!raw) return { completed: false };
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingResult>;
    if (!parsed || typeof parsed !== "object") return { completed: true };
    return {
      completed: parsed.completed !== false, // any stored blob counts as handled
      ...(parsed.skipped ? { skipped: true } : {}),
      ...(typeof parsed.interpreter === "string" ? { interpreter: parsed.interpreter } : {}),
      ...(parsed.modelChoice ? { modelChoice: parsed.modelChoice } : {}),
      ...(typeof parsed.theme === "string" ? { theme: parsed.theme } : {}),
      ...(typeof parsed.tokensOptIn === "boolean" ? { tokensOptIn: parsed.tokensOptIn } : {}),
      ...(typeof parsed.ts === "number" ? { ts: parsed.ts } : {}),
    };
  } catch {
    return { completed: true }; // corrupt → assume completed (don't nag)
  }
}

/** Finalize a result for persistence: stamp `completed` (+ `skipped`) + the timestamp. */
export function finalizeResult(
  result: Omit<OnboardingResult, "completed">,
  opts: { skipped?: boolean; ts: number },
): OnboardingResult {
  return {
    ...result,
    completed: true,
    ...(opts.skipped ? { skipped: true } : {}),
    ts: opts.ts,
  };
}

export function serializeResult(result: OnboardingResult): string {
  return JSON.stringify(result);
}
