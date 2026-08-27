/**
 * pre-write-recheck.test.ts — the "flight-check" contributor.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PreambleCtx } from "../preamble-dispatch.js";
import {
  FLIGHT_CHECK_LOCAL_SUFFIX,
  FLIGHT_CHECK_TEXT,
  preWriteRecheckContributor,
} from "./pre-write-recheck.js";

const ctx = (over: Partial<PreambleCtx>): PreambleCtx => ({
  surface: "cli",
  isSubAgent: false,
  readOnly: false,
  locality: "cloud",
  tools: [],
  ...over,
});

test("applies: false for read-only, true otherwise", () => {
  assert.equal(preWriteRecheckContributor.applies(ctx({ readOnly: true })), false);
  assert.equal(preWriteRecheckContributor.applies(ctx({ readOnly: false })), true);
});

test("render on a strong hosted ctx returns the checklist with NO local suffix", () => {
  const unit = preWriteRecheckContributor.render(
    ctx({ locality: "cloud", effortTier: "high" }),
    10_000,
  );
  assert.equal(unit?.text, FLIGHT_CHECK_TEXT);
});

test("render on a local / low-effort / off-effort ctx appends the local suffix", () => {
  for (const over of [
    { locality: "local" as const, effortTier: "high" as const },
    { locality: "cloud" as const, effortTier: "low" as const },
    { locality: "cloud" as const, effortTier: "off" as const },
  ]) {
    const unit = preWriteRecheckContributor.render(ctx(over), 10_000);
    assert.ok(unit?.text.endsWith(FLIGHT_CHECK_LOCAL_SUFFIX));
  }
});

test("render on a strong hosted, high-effort ctx does NOT append the local suffix", () => {
  const unit = preWriteRecheckContributor.render(
    ctx({ locality: "cloud", effortTier: "max" }),
    10_000,
  );
  assert.ok(!unit?.text.endsWith(FLIGHT_CHECK_LOCAL_SUFFIX));
});

test("the checklist contains all four numbered items literally", () => {
  for (const marker of ["(1)", "(2)", "(3)", "(4)"]) {
    assert.ok(FLIGHT_CHECK_TEXT.includes(marker), `missing ${marker}`);
  }
});
