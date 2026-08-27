/**
 * ai/guardrails/budgetWindows.test.ts — summarizeSpend (roadmap point 4: budget visibility).
 *
 * evaluateBudgets/decideBudget's own behavior is exercised via budgetGate.test.ts; this file
 * covers only the newer read-only summary function, which must reuse the exact same per-record
 * pricing and local-day bucketing so a status display can never silently disagree with the real
 * enforcement gate about what's been spent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PriceFor, SpendRecord } from "./budgetWindows.js";
import { summarizeSpend } from "./budgetWindows.js";

const CLAUDE_PRICE: PriceFor = (model) =>
  model === "claude-opus"
    ? { pricePerMTokIn: 15, pricePerMTokOut: 75 }
    : model === "local-llama"
      ? { pricePerMTokIn: null, pricePerMTokOut: null } // a real, priced-at-zero local model
      : undefined; // no price entry at all ⇒ unpriced

function rec(over: Partial<SpendRecord>): SpendRecord {
  return {
    model: "claude-opus",
    promptTokens: 1_000_000,
    completionTokens: 0,
    estimated: false,
    atIso: "2026-08-19T12:00:00.000Z",
    ...over,
  };
}

test("summarizeSpend: sums priced records into sessionSpentUsd", () => {
  const s = summarizeSpend(
    [
      rec({ promptTokens: 1_000_000, completionTokens: 0 }),
      rec({ promptTokens: 1_000_000, completionTokens: 0 }),
    ],
    "2026-08-19T18:00:00.000Z",
    CLAUDE_PRICE,
  );
  assert.equal(s.sessionSpentUsd, 30); // 2 x ($15/MTok in x 1M tokens)
});

test("summarizeSpend: dailySpentUsd only counts records on nowIso's LOCAL calendar day", () => {
  const s = summarizeSpend(
    [
      rec({ atIso: "2026-08-19T12:00:00.000Z", promptTokens: 1_000_000, completionTokens: 0 }),
      rec({ atIso: "2026-08-18T12:00:00.000Z", promptTokens: 1_000_000, completionTokens: 0 }), // yesterday
    ],
    "2026-08-19T18:00:00.000Z",
    CLAUDE_PRICE,
  );
  assert.equal(s.sessionSpentUsd, 30, "session total includes every record handed in");
  assert.equal(s.dailySpentUsd, 15, "daily total excludes yesterday's record");
});

test("summarizeSpend: a real free/local model (both rates null) counts as an honest $0, not unpriced", () => {
  const s = summarizeSpend(
    [rec({ model: "local-llama", promptTokens: 1_000_000, completionTokens: 1_000_000 })],
    "2026-08-19T18:00:00.000Z",
    CLAUDE_PRICE,
  );
  assert.equal(s.sessionSpentUsd, 0);
  assert.deepEqual(s.unpriced, []);
});

test("summarizeSpend: a model with NO price entry is listed as unpriced and excluded from both totals", () => {
  const s = summarizeSpend(
    [
      rec({ model: "claude-opus", promptTokens: 1_000_000, completionTokens: 0 }),
      rec({ model: "mystery-model", promptTokens: 1_000_000, completionTokens: 1_000_000 }),
    ],
    "2026-08-19T18:00:00.000Z",
    CLAUDE_PRICE,
  );
  assert.equal(s.sessionSpentUsd, 15, "the unpriced record contributes nothing to the total");
  assert.deepEqual(s.unpriced, ["mystery-model"]);
});

test("summarizeSpend: an empty record set is a clean $0, not an error", () => {
  const s = summarizeSpend([], "2026-08-19T18:00:00.000Z", CLAUDE_PRICE);
  assert.deepEqual(s, { sessionSpentUsd: 0, dailySpentUsd: 0, unpriced: [] });
});
