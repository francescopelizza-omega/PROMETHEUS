/**
 * tokens-report.test.ts — the PURE cache-economy aggregation behind `prom tokens report` (CLI-090).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Pricing } from "@prometheus/core";

import type { AccountingRecord } from "../session/history-store.js";
import { buildCacheReport, cacheSavingsCoeff } from "./tokens-report.js";

const rec = (over: Partial<AccountingRecord>): AccountingRecord => ({
  model: "claude-sonnet-4",
  endpointId: "anthropic",
  promptTokens: 1000,
  completionTokens: 200,
  estimated: false,
  atIso: "2026-07-18T00:00:00Z",
  ...over,
});

const PRICING: Pricing = {
  "claude-sonnet-4": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "gpt-4o": { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 },
};

const findTech = (r: ReturnType<typeof buildCacheReport>, id: string) =>
  r.techniques.find((t) => t.id === id);

test("cacheSavingsCoeff: Anthropic 0.9, OpenAI 0.5, Gemini 0.75, unknown → 0.9 (CLI-090)", () => {
  assert.equal(cacheSavingsCoeff("claude-sonnet-4"), 0.9);
  assert.equal(cacheSavingsCoeff("gpt-4o"), 0.5);
  assert.equal(cacheSavingsCoeff("o3-mini"), 0.5);
  assert.equal(cacheSavingsCoeff("gemini-2.0-flash"), 0.75);
  assert.equal(cacheSavingsCoeff("mystery-model"), 0.9);
});

test("session WITH cache-read data → prompt-caching measured + estimated $ saved (CLI-090)", () => {
  const records = [
    rec({ cacheRead: 60000, cacheCreate: 5000 }),
    rec({ cacheRead: 40000 }), // 100k cache-read total on a $3/Mtok input model, coeff 0.9
  ];
  const r = buildCacheReport(records, { "prompt-caching": true }, PRICING, "s1");
  assert.equal(r.measurable, true);
  assert.equal(r.raw.cacheRead, 100000);
  assert.equal(r.raw.cacheCreate, 5000);
  const pc = findTech(r, "prompt-caching");
  assert.ok(pc);
  assert.equal(pc?.measured, true);
  assert.equal(pc?.enabled, true);
  assert.equal(pc?.cacheReadTokens, 100000);
  // 100000/1e6 × 3 × 0.9 = 0.27
  assert.ok(Math.abs((pc?.estSavedUsd ?? 0) - 0.27) < 1e-9);
});

test("session with NO cache field → not-available (never 0), all others advisory (CLI-090)", () => {
  const records = [rec({}), rec({})]; // real turns, but no cache field on any usage payload
  const r = buildCacheReport(records, {}, PRICING, "s2");
  assert.equal(r.measurable, false);
  const pc = findTech(r, "prompt-caching");
  assert.equal(pc?.measured, false);
  assert.match(pc?.note ?? "", /not available for this provider/);
  // every other technique is honestly "advisory only", never a fabricated number
  for (const t of r.techniques.filter((t) => t.id !== "prompt-caching")) {
    assert.equal(t.measured, false);
    assert.match(t.note ?? "", /advisory only/);
  }
});

test("cache-read measured but model UNPRICED → estSavedUsd null (n/a, no fabricated $) (CLI-090)", () => {
  const records = [rec({ model: "local-qwen", endpointId: "ollama", cacheRead: 50000 })];
  const r = buildCacheReport(records, { "prompt-caching": true }, PRICING, "s3");
  const pc = findTech(r, "prompt-caching");
  assert.equal(pc?.measured, true);
  assert.equal(pc?.cacheReadTokens, 50000);
  assert.equal(pc?.estSavedUsd, null); // measured tokens, unknown price → n/a
});

test("empty session (no records) → measurable false, prompt-caching not-available (CLI-090)", () => {
  const r = buildCacheReport([], {}, PRICING, null);
  assert.equal(r.turns, 0);
  assert.equal(r.measurable, false);
  assert.equal(findTech(r, "prompt-caching")?.measured, false);
});

test("cache-CREATE-only session is measurable (not 'no cache field') — matches raw.cacheCreate>0", () => {
  const records = [rec({ model: "claude-sonnet-4", cacheCreate: 1000 })]; // no cacheRead
  const r = buildCacheReport(records, { "prompt-caching": true }, PRICING, "s");
  assert.equal(r.raw.cacheCreate, 1000);
  assert.equal(r.measurable, true, "a cache-create field is a measured signal");
  const pc = r.techniques.find((t) => t.id === "prompt-caching");
  assert.equal(pc?.measured, true);
  assert.equal(pc?.cacheCreateTokens, 1000);
});
