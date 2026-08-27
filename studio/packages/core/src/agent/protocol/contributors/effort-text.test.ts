/**
 * effort-text.test.ts — effort tuning, as prose, for a model with no request-parameter mechanism.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveEffort } from "../../../ai/effort/apply.js";
import type { EffortTier } from "../../../ai/effort/types.js";
import type { PreambleCtx } from "../preamble-dispatch.js";
import { effortText, effortTextContributor } from "./effort-text.js";

const ctx = (effortTier: PreambleCtx["effortTier"], effortMechanism?: string): PreambleCtx => ({
  surface: "cli",
  isSubAgent: false,
  readOnly: false,
  locality: "local",
  tools: [],
  effortTier,
  effortMechanism,
});

const TIERS: readonly EffortTier[] = ["off", "low", "medium", "high", "max"];
const MECHANISMS = [
  undefined,
  "none",
  "effort-enum",
  "native-graded",
  "always-on",
  "template-kwarg",
  "system-prompt-line",
  "prompt-soft-switch",
] as const;

test("applies: true only for a non-off tier AND an UNRESOLVED, NONE, or TEMPLATE-KWARG mechanism", () => {
  // Any mechanism that already RELIABLY communicates the tier some other way (a request
  // parameter, a trained-on prompt line) must NOT also get this textual fallback. `template-kwarg`
  // joins `undefined`/`none` here — `ai/effort/rules.ts` documents it `optimistic: true`, a
  // silent no-op unless the model's template happens to branch on the kwarg — so it is just as
  // unreliable as having no mechanism at all.
  for (const tier of TIERS) {
    for (const mechanism of MECHANISMS) {
      const applies = effortTextContributor.applies(ctx(tier, mechanism));
      const hasRealTier = tier !== undefined && tier !== "off";
      const mechanismUnreliable =
        mechanism === undefined || mechanism === "none" || mechanism === "template-kwarg";
      const expected = hasRealTier && mechanismUnreliable;
      assert.equal(applies, expected, `tier=${tier} mechanism=${mechanism}`);
    }
  }
});

test("template-kwarg specifically gets the textual nudge (regression: it used to be left in limbo)", () => {
  assert.equal(effortTextContributor.applies(ctx("high", "template-kwarg")), true);
});

test("the double-injection guard: system-prompt-line / prompt-soft-switch never apply, even at high effort", () => {
  assert.equal(effortTextContributor.applies(ctx("high", "system-prompt-line")), false);
  assert.equal(effortTextContributor.applies(ctx("high", "prompt-soft-switch")), false);
});

test("an UNRESOLVED mechanism (undefined) still offers the nudge — assume the worst, try anyway", () => {
  assert.equal(effortTextContributor.applies(ctx("high", undefined)), true);
});

test("render returns the exact matching prose for each non-off tier", () => {
  for (const tier of ["low", "medium", "high", "max"] as const) {
    const unit = effortTextContributor.render(ctx(tier), 10_000);
    assert.equal(unit?.text, effortText(tier));
    assert.ok(unit?.text && unit.text.length > 0);
  }
});

test("effortText(off) and effortText(undefined) are null", () => {
  assert.equal(effortText("off"), null);
  assert.equal(effortText(undefined), null);
});

/* ── the anti-drift assertion ───────────────────────────────────────────────*/

test("resolveEffort REPORTS exactly the instruction this contributor INJECTS", () => {
  // This is the whole reason the prompt table moved to `ai/effort/emulation.ts`. It used to
  // live privately in this file, so `/think high` on a knobless model printed "not available"
  // — true of the request parameter, false of the outcome — while this contributor injected a
  // graded instruction on every single turn. Two copies of one table, and only one of them was
  // visible to the layer that reports to the user.
  const knobless = { mechanism: "none" as const, supported: [] };
  for (const tier of ["low", "medium", "high", "max"] as const) {
    const resolution = resolveEffort(tier, knobless);
    const injected = effortText(tier);
    assert.equal(resolution.emulation?.text, injected, `${tier}: the two tables have drifted`);
    assert.ok(injected && injected.length > 0);
  }
});

test("`off` is silent on both sides — no report, no injection", () => {
  assert.equal(effortText("off"), null);
  assert.equal(resolveEffort("off", { mechanism: "none", supported: [] }).emulation, undefined);
  assert.equal(effortTextContributor.applies(ctx("off")), false);
});

test("an ALWAYS-ON model is emulated by neither side", () => {
  // It already reasons at a fixed depth; a "think harder" line cannot move it, so injecting one
  // would spend tokens implying a control we do not have.
  assert.equal(
    resolveEffort("high", { mechanism: "always-on", supported: [] }).emulation,
    undefined,
  );
  assert.equal(effortTextContributor.applies(ctx("high", "always-on")), false);
});
