/**
 * ai.test.ts — the pure AI-Providers projections (file 12 §4/§5): promotion sort,
 * the §4.1 warn copy + typed-confirm predicate, and the §4.3 spend-meter model.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type AiProviderRow,
  ENABLE_METERED_PHRASE,
  confirmEnabled,
  costWarningCopy,
  groupByTier,
  sortProviderRows,
  spendBarText,
  spendMeterModel,
} from "./types.js";

const ROWS: AiProviderRow[] = [
  {
    id: "openrouter",
    label: "OpenRouter / Groq",
    tier: "C",
    kind: "api-key",
    warnLevel: "loud",
    caption: "metered",
    openWeight: true,
    repointSuggest: true,
  },
  {
    id: "claude",
    label: "Claude (Pro/Max)",
    tier: "B",
    kind: "oauth-subscription-bridge",
    warnLevel: "gentle",
    caption: "subscription-included",
    verifyAtSetup: true,
  },
  {
    id: "gpt-oss",
    label: "gpt-oss:20b",
    tier: "A",
    kind: "local-serve",
    warnLevel: "none",
    caption: "local-serve",
    openWeight: true,
  },
  {
    id: "qwen",
    label: "qwen3:8b",
    tier: "A",
    kind: "local-serve",
    warnLevel: "none",
    caption: "local-serve",
    openWeight: true,
  },
];

// ---- promotion sort (§5) --------------------------------------------------- //

test("sortProviderRows is A before B before C, label-stable within a tier", () => {
  const sorted = sortProviderRows(ROWS);
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["gpt-oss", "qwen", "claude", "openrouter"],
  );
});

test("groupByTier yields only non-empty tiers in promotion order", () => {
  const groups = groupByTier(ROWS);
  assert.deepEqual(
    groups.map((g) => g.tier),
    ["A", "B", "C"],
  );
  assert.equal(groups[0]?.rows.length, 2);
});

// ---- §4.1 warn copy + typed-confirm --------------------------------------- //

test("costWarningCopy carries the verbatim title + the metered billing line", () => {
  const copy = costWarningCopy({
    providerLabel: "OpenRouter",
    modelLabel: "deepseek-chat",
    priceLine: "~$0.27 / 1M in",
    repointSuggest: true,
  });
  assert.match(copy.title, /PAY-PER-USE SERVICE/);
  assert.equal(copy.phrase, ENABLE_METERED_PHRASE);
  assert.match(copy.billingLine, /METERED — not covered/);
  assert.ok(copy.modelLine?.includes("deepseek-chat"));
  assert.ok(copy.localAltCta, "an open-weight provider offers the local escape hatch");
  assert.equal(copy.confirmLabel, "Enable metered service");
});

test("costWarningCopy omits the local CTA when the model can't run locally", () => {
  const copy = costWarningCopy({ providerLabel: "Anthropic API", modelLabel: "claude-opus-4-8" });
  assert.equal(copy.localAltCta, undefined);
});

test("confirmEnabled requires the EXACT phrase AND a positive cap", () => {
  assert.equal(confirmEnabled("ENABLE METERED", 20), true);
  assert.equal(confirmEnabled("ENABLE METERED", 0), false, "no cap → no confirm");
  assert.equal(confirmEnabled("enable metered", 20), false, "case-sensitive");
  assert.equal(confirmEnabled("ENABLE METERED ", 20), false, "trailing space must not pass");
  assert.equal(confirmEnabled("", 20), false);
});

// ---- §4.3 spend meter ------------------------------------------------------ //

test("spendMeterModel formats the line and bands by spend", () => {
  const ok = spendMeterModel(4.2, 20);
  assert.equal(ok.line, "$4.20 / $20.00 · 21%");
  assert.equal(ok.band, "ok");
  assert.equal(ok.role, "ok");
  assert.equal(spendMeterModel(17, 20).band, "warn");
  assert.equal(spendMeterModel(17, 20).role, "warn");
  const over = spendMeterModel(25, 20);
  assert.equal(over.band, "over");
  assert.equal(over.role, "danger");
  assert.equal(over.fraction, 1, "fill clamps at 100%");
});

test("spendBarText fills proportionally and clamps", () => {
  assert.equal(spendBarText(0.3, 10), "▓▓▓░░░░░░░");
  assert.equal(spendBarText(2, 4), "▓▓▓▓");
  assert.equal(spendBarText(-1, 4), "░░░░");
});
