/**
 * recents.test.ts — the age phrasing the Home islands render.
 *
 * Two regressions are pinned here, both from a caller suffixing `ageLabel` by hand:
 *   1. `ageLabel` returns the COMPLETE phrase "now" under a minute, so "…} ago" produced
 *      the literal "now ago" on every freshly-scanned artifact.
 *   2. `Date.parse` of an absent/garbage timestamp is NaN, which falls through every
 *      comparison inside `ageLabel` and renders the literal string "NaN d".
 */
import assert from "node:assert/strict";
import test from "node:test";

import { ageLabel, agoLabel } from "./recents.js";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const minutesAgo = (m: number): string => new Date(T0 - m * 60_000).toISOString();

test("ageLabel: the bare age column", () => {
  assert.equal(ageLabel(T0, T0), "now");
  assert.equal(ageLabel(T0 - 5 * 60_000, T0), "5 m");
  assert.equal(ageLabel(T0 - 2 * 3_600_000, T0), "2 h");
  assert.equal(ageLabel(T0 - 3 * 86_400_000, T0), "3 d");
});

test('agoLabel: "now" is never suffixed', () => {
  assert.equal(agoLabel(minutesAgo(0), T0), "now");
  assert.equal(agoLabel(minutesAgo(0.5), T0), "now");
});

test("agoLabel: everything else gets the suffix exactly once", () => {
  assert.equal(agoLabel(minutesAgo(5), T0), "5 m ago");
  assert.equal(agoLabel(minutesAgo(120), T0), "2 h ago");
  assert.equal(agoLabel(minutesAgo(60 * 24 * 3), T0), "3 d ago");
});

test("agoLabel: an unparseable or absent timestamp is null, never “NaN d”", () => {
  assert.equal(agoLabel(undefined, T0), null);
  assert.equal(agoLabel(null, T0), null);
  assert.equal(agoLabel("", T0), null);
  assert.equal(agoLabel("not a date", T0), null);
});
