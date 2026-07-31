import assert from "node:assert/strict";
/**
 * guardrails.test.ts — CostGuardrail evaluation (C11).
 *
 * Covers under-cap, warning threshold, over-cap auto-disable, the fail-closed
 * zero/absent-cap behaviour, input coercion (NaN/negative/Infinity), and the
 * recordSpend + describeGuardrail helpers.
 */
import { test } from "node:test";

import type { CostGuardrail } from "../domain/models.js";
import { describeGuardrail, evaluateGuardrail, recordSpend } from "./guardrails.js";

function g(p: Partial<CostGuardrail>): CostGuardrail {
  return { providerId: "claude", budgetCap: 100, spent: 0, ...p };
}

test("under cap: remaining computed, not over, not warning, not auto-disabled", () => {
  const ev = evaluateGuardrail(g({ spent: 40 }));
  assert.equal(ev.remaining, 60);
  assert.equal(ev.overCap, false);
  assert.equal(ev.warning, false);
  assert.equal(ev.shouldAutoDisable, false);
  assert.equal(ev.fractionUsed, 0.4);
  assert.equal(ev.currency, "USD");
});

test("soft warn threshold trips below cap when configured", () => {
  const ev = evaluateGuardrail(g({ spent: 85, warnAtFraction: 0.8 }));
  assert.equal(ev.overCap, false);
  assert.equal(ev.warning, true);
  assert.equal(ev.shouldAutoDisable, false);
});

test("warning never fires once over cap (overCap wins)", () => {
  const ev = evaluateGuardrail(g({ spent: 120, warnAtFraction: 0.8 }));
  assert.equal(ev.overCap, true);
  assert.equal(ev.warning, false);
});

test("over cap with default auto-disable => shouldAutoDisable true", () => {
  const ev = evaluateGuardrail(g({ spent: 100 }));
  assert.equal(ev.overCap, true);
  assert.equal(ev.shouldAutoDisable, true, "spent>=cap auto-disables by default");
  assert.equal(ev.remaining, 0);
});

test("over cap but autoDisableAtCap:false keeps it running (explicit opt-out)", () => {
  const ev = evaluateGuardrail(g({ spent: 150, autoDisableAtCap: false }));
  assert.equal(ev.overCap, true);
  assert.equal(ev.shouldAutoDisable, false);
});

test("fail-closed: zero/absent budget cap is over cap with any spend", () => {
  const zero = evaluateGuardrail(g({ budgetCap: 0, spent: 0 }));
  assert.equal(zero.overCap, true, "a zero cap authorises no spend");
  assert.equal(zero.shouldAutoDisable, true);

  const zeroSpent = evaluateGuardrail(g({ budgetCap: 0, spent: 5 }));
  assert.equal(zeroSpent.overCap, true);
});

test("input coercion: negative / NaN / Infinity are sanitised", () => {
  const ev = evaluateGuardrail(g({ budgetCap: 100, spent: Number.NaN }));
  assert.equal(ev.spent, 0);
  assert.equal(ev.overCap, false);

  const neg = evaluateGuardrail(g({ budgetCap: -50, spent: -10 }));
  // negative cap => coerced to 0 => no budget => over cap
  assert.equal(neg.budgetCap, 0);
  assert.equal(neg.spent, 0);
  assert.equal(neg.overCap, true);
});

test("currency passes through", () => {
  const ev = evaluateGuardrail(g({ currency: "EUR", spent: 10 }));
  assert.equal(ev.currency, "EUR");
});

test("recordSpend returns a NEW guardrail with summed spend", () => {
  const base = g({ spent: 10 });
  const next = recordSpend(base, 5.5);
  assert.equal(next.spent, 15.5);
  assert.equal(base.spent, 10, "original untouched");
  // bad amounts are ignored
  assert.equal(recordSpend(base, Number.NaN).spent, 10);
  assert.equal(recordSpend(base, -3).spent, 10);
});

test("describeGuardrail renders distinct states", () => {
  assert.match(describeGuardrail(evaluateGuardrail(g({ spent: 20 }))), /remaining/);
  assert.match(
    describeGuardrail(evaluateGuardrail(g({ spent: 85, warnAtFraction: 0.8 }))),
    /approaching cap/,
  );
  assert.match(describeGuardrail(evaluateGuardrail(g({ spent: 100 }))), /CAP REACHED/);
  assert.match(
    describeGuardrail(evaluateGuardrail(g({ spent: 150, autoDisableAtCap: false }))),
    /OVER CAP/,
  );
});
