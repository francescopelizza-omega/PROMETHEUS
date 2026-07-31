/**
 * ladder.test.ts — the deterministic fallback ladder + edit.ts integration.
 *
 * The cardinal property under test is BYTE-PRESERVATION: every untouched region survives
 * byte-for-byte across LF / CRLF / mixed / BOM / trailing-newline files, and the exact rung
 * is unchanged when opts.fallback is off (zero behavior drift on the historical path).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { diagnoseFailedEdit } from "./diagnose.js";
import { applyProposedEdit, parseHunksResult } from "./edit.js";
import { resolveHunk } from "./ladder.js";
import { balanceScore, verifyEdit } from "./verify.js";

const H = (o: string, n: string) => [{ old: o, new: n }];

/* ── exact rung parity (fallback OFF ⇒ identical to historical behavior) ─────── */

test("exact: unique match applies", () => {
  const r = applyProposedEdit("a\nfoo\nb\n", H("foo", "FOO"));
  assert.ok(r.ok && r.next === "a\nFOO\nb\n" && r.rungs.join() === "exact");
});

test("exact: no-match fails closed (fallback off)", () => {
  // an indent drift the fallback ladder WOULD recover, but fallback is off ⇒ stays no-match
  const r = applyProposedEdit(
    "    def foo():\n        return 1\n",
    H("def foo():\n    return 1", "x"),
  );
  assert.ok(!r.ok && r.code === "no-match");
});

test("exact: 2+ occurrences ⇒ ambiguous, never first-win", () => {
  const r = applyProposedEdit("foo\nfoo\n", H("foo", "X"));
  assert.ok(!r.ok && r.code === "ambiguous");
});

/* ── byte-preservation across line-ending styles ────────────────────────────── */

test("CRLF file: untouched CRLF endings preserved, region re-styled CRLF", () => {
  const r = applyProposedEdit("l1\r\nl2\r\nl3\r\n", H("l2", "L2"));
  assert.ok(r.ok && r.next === "l1\r\nL2\r\nl3\r\n");
});

test("MIXED endings: LF line stays LF, CRLF lines stay CRLF (no blanket reapply corruption)", () => {
  const r = applyProposedEdit("a\r\nb\nc\r\n", H("b", "B"));
  assert.ok(r.ok && r.next === "a\r\nB\nc\r\n", `got ${JSON.stringify(r.ok && r.next)}`);
});

test("no trailing newline preserved", () => {
  const r = applyProposedEdit("x\ny", H("y", "Y"));
  assert.ok(r.ok && r.next === "x\nY");
});

test("trailing newline preserved", () => {
  const r = applyProposedEdit("x\ny\n", H("y", "Y"));
  assert.ok(r.ok && r.next === "x\nY\n");
});

test("BOM preserved", () => {
  const r = applyProposedEdit("﻿x\ny\n", H("y", "Y"));
  assert.ok(r.ok && r.next === "﻿x\nY\n");
});

test("multi-hunk sequential apply", () => {
  const r = applyProposedEdit("a\nb\nc\n", [
    { old: "a", new: "A" },
    { old: "c", new: "C" },
  ]);
  assert.ok(r.ok && r.next === "A\nb\nC\n");
});

/* ── fallback rungs (opts.fallback) ──────────────────────────────────────────── */

test("trailing-ws rung: model dropped a trailing space", () => {
  const r = applyProposedEdit("foo \nbar", H("foo\nbar", "FOO\nBAR"), { fallback: true });
  assert.ok(r.ok && r.next === "FOO\nBAR" && r.rungs.join() === "trailing-ws");
});

test("indent rung: under-indented block located + replacement re-indented", () => {
  const src = "    def foo():\n        return 1\n";
  const r = applyProposedEdit(src, H("def foo():\n    return 1", "def foo():\n    return 2"), {
    fallback: true,
  });
  assert.ok(r.ok && r.next === "    def foo():\n        return 2\n", JSON.stringify(r));
  assert.equal(r.ok && r.rungs.join(), "indent");
});

test("indent rung declines tab-vs-space (constant-add impossible), anchor still locates by content", () => {
  const src = "\tfoo\n\tbar\n"; // file uses tabs
  const r = applyProposedEdit(src, H("    foo\n    bar", "X"), { fallback: true }); // model used spaces
  // indent declines the tab/space delta; anchor locates uniquely by trimmed content
  assert.ok(r.ok && r.next === "X\n" && r.rungs.join() === "anchor", JSON.stringify(r));
});

test("ladder fails closed when content is genuinely absent", () => {
  const r = applyProposedEdit("\tfoo\n\tbar\n", H("    zzz\n    qux", "X"), { fallback: true });
  assert.ok(!r.ok && r.code === "no-match");
});

test("anchor rung: interior line stable, edges drifted", () => {
  const src = "header\nUNIQUE_ANCHOR\nfooter\n";
  // model reproduced the anchor but mis-typed the edges' whitespace so exact/trailing/indent miss
  const r = applyProposedEdit(src, H("header \nUNIQUE_ANCHOR\n footer", "H\nUNIQUE_ANCHOR\nF"), {
    fallback: true,
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.ok && r.rungs.join(), "anchor");
});

test("fallback ambiguity stops (never escalates to first-win)", () => {
  const r = applyProposedEdit("x \nx \n", H("x", "Y"), { fallback: true });
  // "x" appears twice even after trailing-ws; must be ambiguous
  assert.ok(!r.ok && r.code === "ambiguous");
});

test("resolveHunk exact returns offsets", () => {
  const r = resolveHunk("abcdef", "cd", "CD", {});
  assert.ok(r.ok && r.start === 2 && r.end === 4 && r.replacement === "CD" && r.rung === "exact");
});

/* ── parseHunksResult reports dropped (no silent partial apply) ──────────────── */

test("parseHunksResult flags malformed + dropped", () => {
  const good = parseHunksResult([{ old: "a", new: "b" }]);
  assert.deepEqual(good, { hunks: [{ old: "a", new: "b" }], dropped: 1 - 1, malformed: false });
  const mixed = parseHunksResult([{ old: "a", new: "b" }, { old: 1 }]);
  assert.equal(mixed.hunks.length, 1);
  assert.equal(mixed.dropped, 1);
  const bad = parseHunksResult("not json");
  assert.ok(bad.malformed && bad.hunks.length === 0);
});

/* ── verify: balance-delta blocks only when WORSE ────────────────────────────── */

test("verify blocks a dropped closing bracket", () => {
  const v = verifyEdit("f(a)\n", "f(a\n");
  assert.ok(!v.ok);
});

test("verify passes an edit that fixes balance", () => {
  const v = verifyEdit("f(a\n", "f(a)\n");
  assert.ok(v.ok);
});

test("verify passes a partial-file snippet (already unbalanced, not worsened)", () => {
  const v = verifyEdit("  foo(\n", "  bar(\n");
  assert.ok(v.ok);
  assert.equal(balanceScore("  bar(\n").brackets, 1);
});

/* ── diagnose: grounded retry hints ─────────────────────────────────────────── */

test("diagnose returns the file's exact bytes on a whitespace-only miss", () => {
  const hint = diagnoseFailedEdit("    hello\nworld\n", "hello\nworld", "no-match");
  assert.equal(hint.correctedOld, "    hello\nworld");
  assert.ok(hint.whitespaceHint && hint.sites?.[0] === 1);
});

test("diagnose reports ambiguous sites", () => {
  const hint = diagnoseFailedEdit("foo\nfoo\n", "foo", "ambiguous");
  assert.equal(hint.code, "ambiguous");
  assert.deepEqual(hint.sites, [1, 2]);
});
