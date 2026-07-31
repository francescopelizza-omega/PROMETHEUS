/**
 * onboarding-state.test.ts — the PURE first-run wizard step machine + persistence (APP-064).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type OnboardingResult,
  STEP_ORDER,
  finalizeResult,
  isTerminal,
  loadOnboarding,
  nextStep,
  prevStep,
  serializeResult,
  shouldShowWizard,
} from "./onboarding-state.js";

test("step machine: next/prev walk STEP_ORDER + clamp at the ends", () => {
  assert.deepEqual([...STEP_ORDER], ["welcome", "interpreter", "model", "theme", "tokens", "done"]);
  assert.equal(nextStep("welcome"), "interpreter");
  assert.equal(nextStep("tokens"), "done");
  assert.equal(nextStep("done"), "done"); // clamped
  assert.equal(prevStep("interpreter"), "welcome");
  assert.equal(prevStep("welcome"), "welcome"); // clamped
  assert.equal(isTerminal("done"), true);
  assert.equal(isTerminal("theme"), false);
});

test("shouldShowWizard: ONLY when the flag is absent — corrupt/valid both suppress", () => {
  assert.equal(shouldShowWizard(null), true); // fresh profile → show
  assert.equal(shouldShowWizard(undefined), true);
  assert.equal(shouldShowWizard(JSON.stringify({ completed: true })), false);
  assert.equal(shouldShowWizard(JSON.stringify({ skipped: true })), false);
  assert.equal(shouldShowWizard("{corrupt"), false); // corrupt → don't nag
  assert.equal(shouldShowWizard(""), false); // any non-null value suppresses
});

test("finalize + serialize + load round-trips the choices", () => {
  const finalized = finalizeResult(
    { interpreter: "/venv/bin/python", modelChoice: "local", theme: "dracula", tokensOptIn: true },
    { ts: 1234 },
  );
  assert.equal(finalized.completed, true);
  assert.equal(finalized.ts, 1234);
  const round = loadOnboarding(serializeResult(finalized));
  assert.equal(round.interpreter, "/venv/bin/python");
  assert.equal(round.modelChoice, "local");
  assert.equal(round.theme, "dracula");
  assert.equal(round.tokensOptIn, true);
});

test("skip is remembered (completed + skipped); corrupt load → completed (no nag)", () => {
  const skipped = finalizeResult({ modelChoice: "later" }, { ts: 5, skipped: true });
  assert.equal(skipped.completed, true);
  assert.equal(skipped.skipped, true);
  assert.equal(loadOnboarding(serializeResult(skipped)).skipped, true);
  // corrupt / absent → completed default (never nags).
  assert.equal(loadOnboarding("{bad json").completed, true);
  assert.equal(loadOnboarding(null).completed, false); // absent → not-yet-completed (App decides via shouldShow)
  // a stored blob with completed:false still loads its choices but counts as handled.
  const partial: OnboardingResult = loadOnboarding(JSON.stringify({ tokensOptIn: false }));
  assert.equal(partial.tokensOptIn, false);
  assert.equal(partial.completed, true);
});
