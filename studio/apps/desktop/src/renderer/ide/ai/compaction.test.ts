/**
 * compaction.test.ts — keeping a long GUI conversation inside the window.
 *
 * The pane never compacted, so a long session grew until the model started refusing or
 * truncating, with no warning and no recovery. Raising the round cap 8 → 32 made that likelier.
 *
 * The tests that matter are the FAIL-SOFT ones. Losing a conversation to a failed attempt at
 * saving it is a far worse outcome than letting it run long, so every failure path here must
 * leave the transcript exactly as it was.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AiTurn } from "../state/stores.js";
import {
  COMPACTED_PREFIX,
  KEEP_RECENT_TURNS,
  compactTurns,
  compactionBudget,
  extractiveSummary,
  needsCompaction,
} from "./compaction.js";

const turn = (content: string, role: AiTurn["role"] = "user"): AiTurn => ({ role, content });
/** A transcript far past any plausible budget. */
const long = (n = 12): AiTurn[] =>
  Array.from({ length: n }, (_, i) => turn("x".repeat(4000), i % 2 === 0 ? "user" : "assistant"));

/* ── when to compact ───────────────────────────────────────────────────────*/

test("an UNKNOWN window disables the check rather than triggering it", () => {
  // The null sentinel is load-bearing: "no window information" must not mean "compact now",
  // which would fire on every single turn.
  assert.equal(compactionBudget(undefined), null);
  assert.equal(compactionBudget(0), null);
  assert.equal(compactionBudget(Number.NaN), null);
  assert.equal(needsCompaction(long(), undefined), false);
});

test("a short conversation is never compacted, however small the window", () => {
  assert.equal(needsCompaction([turn("hi")], 1000), false);
});

test("a transcript at or under the keep window is never compacted", () => {
  // Compacting here would summarize nothing and destroy the recent turns.
  const t = Array.from({ length: KEEP_RECENT_TURNS }, () => turn("x".repeat(9999)));
  assert.equal(needsCompaction(t, 1000), false);
});

test("a long conversation in a small window IS compacted", () => {
  assert.equal(needsCompaction(long(), 8192), true);
});

test("the same conversation in a huge window is left alone", () => {
  assert.equal(needsCompaction(long(), 262_144), false);
});

/* ── fail-soft: the transcript must survive every failure ──────────────────*/

test("a THROWING summarizer does not lose the conversation", async () => {
  const before = long();
  const res = await compactTurns(before, 8192, async () => {
    throw new Error("model unreachable");
  });
  // It still compacts — via the extractive fallback — and keeps the recent tail.
  assert.equal(res.compacted, true);
  assert.equal(res.turns.length, KEEP_RECENT_TURNS + 1);
  assert.match(res.turns[0]?.content ?? "", /user:|assistant:/);
});

test("an EMPTY summary falls back rather than replacing history with nothing", async () => {
  const res = await compactTurns(long(), 8192, async () => "   ");
  assert.equal(res.compacted, true);
  assert.ok((res.turns[0]?.content ?? "").length > COMPACTED_PREFIX.length);
});

test("a transcript of blank turns is left untouched", async () => {
  // Both the summarizer and the fallback can come back empty. Leaving history alone beats
  // replacing it with a summary that says nothing.
  const blanks = Array.from({ length: 12 }, () => turn(""));
  const res = await compactTurns(blanks, 8192, async () => "");
  assert.equal(res.compacted, false);
  assert.equal(res.turns.length, blanks.length);
});

test("nothing to compact returns the transcript unchanged and says so", async () => {
  const before = [turn("hi")];
  const res = await compactTurns(before, 262_144, async () => "summary");
  assert.equal(res.compacted, false);
  assert.deepEqual(res.turns, before);
});

/* ── what compaction produces ──────────────────────────────────────────────*/

test("the summary is MARKED, so it is never mistaken for something that was said", async () => {
  const res = await compactTurns(long(), 8192, async () => "they discussed the parser");
  assert.ok(res.turns[0]?.content.startsWith(COMPACTED_PREFIX));
  assert.match(res.turns[0]?.content ?? "", /they discussed the parser/);
});

test("the most recent turns are kept VERBATIM", async () => {
  const before = long();
  const res = await compactTurns(before, 8192, async () => "s");
  assert.deepEqual(res.turns.slice(1), before.slice(-KEEP_RECENT_TURNS));
});

test("the summarizer is given the OLDER slice only, never the kept tail", async () => {
  const before = long();
  let seen = 0;
  await compactTurns(before, 8192, async (older) => {
    seen = older.length;
    return "s";
  });
  assert.equal(seen, before.length - KEEP_RECENT_TURNS);
});

test("the extractive fallback keeps one line per turn and stays bounded", () => {
  const text = extractiveSummary(long(50), 500);
  assert.ok(text.length <= 501);
  assert.match(text, /^user: /);
});
