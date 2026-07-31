/**
 * marketplace.test.ts — the pure marketplace projections (chip / filter / sort).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type MarketplaceRow,
  filterRows,
  healthDot,
  sortRows,
  tierGlyph,
  verdictChip,
  verdictRank,
} from "./types.js";

test("verdictChip: worst_verdict → {glyph,label,role} (token role, never hex)", () => {
  assert.deepEqual(verdictChip("clean"), { glyph: "✓", label: "clean", role: "ok" });
  assert.deepEqual(verdictChip("medium"), { glyph: "▲", label: "medium", role: "warn" });
  assert.deepEqual(verdictChip("high"), { glyph: "⛔", label: "blocked", role: "danger" });
  assert.deepEqual(verdictChip("block"), { glyph: "⛔", label: "blocked", role: "danger" });
  assert.deepEqual(verdictChip("error"), { glyph: "⚠", label: "scan failed", role: "danger" });
  assert.equal(verdictChip(undefined).role, "text-secondary");
});

test("verdictRank: loudest first ordering", () => {
  assert.ok(verdictRank("block") > verdictRank("medium"));
  assert.ok(verdictRank("medium") > verdictRank("clean"));
  assert.ok(verdictRank("clean") > verdictRank(undefined));
});

test("tierGlyph + healthDot", () => {
  assert.equal(tierGlyph("official"), "◆");
  assert.equal(tierGlyph("documented"), "ⓘ");
  assert.equal(tierGlyph("community"), "✓");
  assert.equal(healthDot("ready").role, "ok");
  assert.equal(healthDot("blocked").glyph, "⛔");
  assert.equal(healthDot("unknown").role, "text-secondary");
});

const ROWS: MarketplaceRow[] = [
  { id: "a", name: "superpowers", repo: "obra/superpowers", rank: 1, worstVerdict: "medium" },
  { id: "b", name: "frontend-design", repo: "anthropics/skills", rank: 3, worstVerdict: "clean" },
  { id: "c", name: "shady", repo: "x/shady", worstVerdict: "block" },
];

test("filterRows: case-insensitive over name/id/repo", () => {
  assert.equal(filterRows(ROWS, "SUPER").length, 1);
  assert.equal(filterRows(ROWS, "anthropics").length, 1);
  assert.equal(filterRows(ROWS, "").length, 3);
  assert.equal(filterRows(ROWS, "zzz").length, 0);
});

test("sortRows: by rank (undefined last), name, verdict (loudest first)", () => {
  assert.deepEqual(
    sortRows(ROWS, "rank").map((r) => r.id),
    ["a", "b", "c"],
  ); // c rank undefined → last
  assert.deepEqual(sortRows(ROWS, "name").map((r) => r.name)[0], "frontend-design");
  assert.deepEqual(sortRows(ROWS, "verdict").map((r) => r.id)[0], "c"); // block loudest
});
