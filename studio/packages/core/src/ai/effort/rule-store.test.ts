/**
 * rule-store.test.ts — a model released next week must not require a build.
 *
 * `rules.ts` promised "adding the 40th model should be a data edit" and `resolveCapability`
 * accepted an injected table from the start — but every caller used the default, so the seam
 * was unreachable. These tests pin the two halves that make it real: strict-enough validation
 * that a bad override cannot become a silent wrong answer, and append-order precedence, which
 * is the whole of the layering story.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEffort, resolveEffort } from "./apply.js";
import { layerEffortRules, parseEffortRules } from "./rule-store.js";
import { builtinRules, resolveCapability } from "./rules.js";

const GOOD = {
  id: "my-model-v9",
  match: { modelIdRegex: "(^|[/:_-])my-model-v9" },
  cap: {
    mechanism: "effort-enum",
    field: "reasoning_effort",
    supported: ["off", "low", "high"],
    enumMap: { off: "none", low: "low", high: "high" },
    note: "my-model-v9 takes the OpenAI vocabulary",
  },
};

test("both file shapes parse — a bare array and a { rules: [...] } wrapper", () => {
  // Both are things a person reasonably writes, and refusing one of them teaches nothing.
  assert.equal(parseEffortRules([GOOD]).rules.length, 1);
  assert.equal(parseEffortRules({ rules: [GOOD] }).rules.length, 1);
});

test("an absent file is not an error — it is the normal case", () => {
  assert.deepEqual(parseEffortRules(undefined), { rules: [], errors: [] });
  assert.deepEqual(parseEffortRules({}), { rules: [], errors: [] });
});

test("`supported` is normalised into LADDER order, whatever order the file used", () => {
  // `nearestTier`'s tie-break assumes ascending order — a file listing high before low would
  // otherwise silently change which tier a clamp lands on.
  const { rules } = parseEffortRules([
    { ...GOOD, cap: { ...GOOD.cap, supported: ["high", "off", "low"] } },
  ]);
  assert.deepEqual(rules[0]?.cap.supported, ["off", "low", "high"]);
});

test("a bad rule is REPORTED and skipped — the rest of the file still loads", () => {
  // Fail-soft, but never silent: a rule the user believes is in force but which vanished is
  // worse than no override at all.
  const { rules, errors } = parseEffortRules([
    { id: "no-match-object", cap: GOOD.cap },
    GOOD,
    { id: "bad-mechanism", match: {}, cap: { mechanism: "telepathy", supported: [] } },
  ]);
  assert.deepEqual(
    rules.map((r) => r.id),
    ["my-model-v9"],
  );
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? "", /rule\[0\].*missing "match"/);
  assert.match(errors[1] ?? "", /rule\[2\].*unknown mechanism "telepathy"/);
});

test("an unknown TIER is refused, not quietly dropped from the supported set", () => {
  // Dropping it would narrow the ladder invisibly — `/think max` would clamp with no reason
  // the user could see, and the file would look correct.
  const { rules, errors } = parseEffortRules([
    { ...GOOD, cap: { ...GOOD.cap, supported: ["low", "maximum"] } },
  ]);
  assert.equal(rules.length, 0);
  assert.match(errors[0] ?? "", /unknown tier "maximum"/);
});

test("a body mechanism with no `field` is refused — it would send nothing and say nothing", () => {
  // This is the exact silent-success shape the whole module exists to prevent: `buildPatch`
  // returns `{kind:"none"}` for a field-less body mechanism, so the tier reads as applied and
  // the request carries no knob.
  for (const mechanism of ["effort-enum", "token-budget", "native-graded", "binary-toggle"]) {
    const { rules, errors } = parseEffortRules([
      { id: `x-${mechanism}`, match: {}, cap: { mechanism, supported: ["high"] } },
    ]);
    assert.equal(rules.length, 0, mechanism);
    assert.match(errors[0] ?? "", /requires a "field"/);
  }
  const kwarg = parseEffortRules([
    { id: "x", match: {}, cap: { mechanism: "template-kwarg", supported: ["off"] } },
  ]);
  assert.match(kwarg.errors[0] ?? "", /requires a "kwarg"/);
});

test("an uncompilable regex is caught HERE, not on the request path", () => {
  const { rules, errors } = parseEffortRules([{ ...GOOD, match: { modelIdRegex: "([unclosed" } }]);
  assert.equal(rules.length, 0);
  assert.match(errors[0] ?? "", /not a valid regular expression/);
});

test("layering keeps the builtins and appends overrides — later wins a specificity tie", () => {
  const layered = layerEffortRules(parseEffortRules([GOOD]).rules);
  assert.equal(layered.length, builtinRules().length + 1);
  assert.equal(layered[layered.length - 1]?.id, "my-model-v9");
  // the builtins are untouched and still resolve
  assert.equal(resolveCapability({ modelId: "gpt-5" }, layered).rule?.id, "openai-reasoning");
});

test("an override BEATS a builtin with the same match, because it is appended after it", () => {
  // No merge step and no override key: append order IS the precedence.
  const override = {
    id: "gemma-3-actually-thinks-here",
    match: { modelIdRegex: "(^|[/:_-])gemma-?(2|3)([^0-9]|$)" },
    cap: {
      mechanism: "effort-enum",
      field: "reasoning_effort",
      supported: ["low", "high"],
      enumMap: { low: "low", high: "high" },
    },
  };
  const base = resolveCapability({ modelId: "gemma3:12b" });
  assert.equal(base.rule?.id, "gemma-2-3");
  assert.equal(base.cap.mechanism, "none");

  const layered = layerEffortRules(parseEffortRules([override]).rules);
  const after = resolveCapability({ modelId: "gemma3:12b" }, layered);
  assert.equal(after.rule?.id, "gemma-3-actually-thinks-here");
  assert.deepEqual(applyEffort({}, resolveEffort("high", after.cap)), {
    reasoning_effort: "high",
  });
});

test("a PROBE still outranks a user override, because specificity beats order", () => {
  // Order only breaks TIES. A probe-backed match scores far higher than a name match, so a
  // workspace file cannot talk a runtime out of what it actually reported.
  const override = {
    id: "claim-qwen3-is-knobless",
    match: { modelIdRegex: "(^|[/:_-])qwen-?3" },
    cap: { mechanism: "none", supported: [] },
  };
  const layered = layerEffortRules(parseEffortRules([override]).rules);
  const probed = resolveCapability(
    { modelId: "qwen3:8b", runtime: "ollama", probedCapabilities: ["thinking"] },
    layered,
  );
  assert.equal(probed.rule?.id, "ollama-openai-shim-thinking");
});

/* ── the sweep: shapes that parsed, resolved, and sent nothing ────────────────────────── */

test("a mechanism whose map cannot express its own `supported` set is refused", () => {
  // The `field` check catches two shapes of this and no more. `effort-enum` with a field and
  // no `enumMap`, `token-budget` with no `budgetMap`, a `promptMap` that covers half its own
  // `supported` — every one of them parses, resolves, reports the tier as applied, and puts
  // nothing on the wire. The parser asks the real patch builder, so it cannot drift from it.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["enumMap", { mechanism: "effort-enum", field: "reasoning_effort", supported: ["high"] }],
    ["budgetMap", { mechanism: "token-budget", field: "thinking.budget", supported: ["high"] }],
    [
      "promptMap",
      { mechanism: "prompt-soft-switch", supported: ["off", "medium"], promptMap: { off: "x" } },
    ],
  ];
  for (const [why, cap] of cases) {
    const { rules, errors } = parseEffortRules({
      rules: [{ id: why, match: { runtime: "ollama" }, cap }],
    });
    assert.deepEqual(rules, [], why);
    assert.match(errors.join(" "), /produces nothing for/, why);
  }
});

test("a well-formed rule of each of those shapes still parses", () => {
  const { rules, errors } = parseEffortRules({
    rules: [
      {
        id: "ok",
        match: { runtime: "ollama", modelIdPrefix: "x" },
        cap: {
          mechanism: "effort-enum",
          field: "reasoning_effort",
          supported: ["low", "high"],
          enumMap: { low: "low", high: "high" },
        },
      },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(rules.length, 1);
});

test("modelIdPrefix must be a string — `startsWith` would coerce a typo into a match", () => {
  const { rules, errors } = parseEffortRules({
    rules: [
      { id: "bad", match: { modelIdPrefix: 123 }, cap: { mechanism: "none", supported: [] } },
    ],
  });
  assert.deepEqual(rules, []);
  assert.match(errors.join(" "), /modelIdPrefix must be a string/);
});
