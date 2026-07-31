/**
 * fim-cache.test.ts — PURE FIM prompt shaping + LRU completion cache (APP-092).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FIM_PREFIX_WINDOW, FimCache, fimCacheKey, fimFamilyOf, fimTemplate } from "./fim-cache.js";

test("fimFamilyOf detects known families, null for unknown", () => {
  assert.equal(fimFamilyOf("Qwen2.5-Coder-7B"), "qwen");
  assert.equal(fimFamilyOf("deepseek-coder-6.7b"), "deepseek");
  assert.equal(fimFamilyOf("bigcode/starcoder2-3b"), "starcoder");
  assert.equal(fimFamilyOf("codellama:13b"), "codellama");
  assert.equal(fimFamilyOf("llama-3.1-8b-instruct"), null); // not a FIM family
  assert.equal(fimFamilyOf(undefined), null);
  assert.equal(fimFamilyOf(""), null);
});

test("fimTemplate emits family-specific tokens; null disables FIM for unknown", () => {
  assert.equal(
    fimTemplate("qwen", "def f(", "):\n    return 1"),
    "<|fim_prefix|>def f(<|fim_suffix|>):\n    return 1<|fim_middle|>",
  );
  assert.equal(fimTemplate("starcoder", "a", "b"), "<fim_prefix>a<fim_suffix>b<fim_middle>");
  assert.equal(fimTemplate("codellama", "a", "b"), "<PRE> a <SUF>b <MID>");
  assert.equal(fimTemplate(null, "a", "b"), null); // unknown family → FIM disabled
});

test("fimCacheKey keys on the trailing prefix + leading suffix window", () => {
  const longPre = `${"x".repeat(FIM_PREFIX_WINDOW + 100)}TAIL`;
  const k = fimCacheKey(longPre, "HEADofsuffix");
  // the key is the prefix TAIL window + a separator + the suffix HEAD window.
  assert.ok(k.startsWith("x") && k.includes("TAIL"), "keeps the prefix tail");
  assert.ok(k.endsWith("HEADofsuffix"), "keeps the suffix head");
  // typing MORE before the window boundary keeps the same key → a cache hit on re-type.
  assert.equal(fimCacheKey(`yyy${longPre}`, "HEADofsuffix"), k);
});

test("FimCache: hit replays without a refetch; LRU evicts oldest; clear drops all", () => {
  const c = new FimCache(2);
  c.set("pre1", "suf", "COMPLETION_1");
  assert.equal(c.get("pre1", "suf"), "COMPLETION_1"); // identical boundary → cached
  assert.equal(c.get("nope", "suf"), undefined); // miss

  c.set("pre2", "suf", "C2");
  // accessing pre1 marks it recent, so inserting a 3rd evicts pre2 (the now-oldest).
  c.get("pre1", "suf");
  c.set("pre3", "suf", "C3");
  assert.equal(c.size, 2);
  assert.equal(c.get("pre1", "suf"), "COMPLETION_1"); // survived (was recent)
  assert.equal(c.get("pre2", "suf"), undefined); // evicted
  assert.equal(c.get("pre3", "suf"), "C3");

  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.get("pre1", "suf"), undefined); // dropped on file-switch clear
});
