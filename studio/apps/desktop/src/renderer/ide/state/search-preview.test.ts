/**
 * search-preview.test.ts — node:test for the PURE search/replace-preview math (§6.3).
 *
 * Pins literal/regex matching, $-group expansion, the per-match preview ids, and the
 * ACCEPT-SUBSET apply (only accepted matches are written, right-to-left within a line
 * so columns stay valid) — the same accept/reject discipline as AI edits (§7.4).
 * Pure — runs under node --test directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Ranked,
  allMatchIds,
  applyReplacements,
  applyToFreshText,
  clipLineForDisplay,
  countMatches,
  cycleTab,
  expandReplacement,
  fuseResults,
  matchFile,
  requiredLiteral,
  tabForMode,
  toggleMatch,
} from "./search-preview.js";

test("literal match finds every occurrence with stable ids", () => {
  const fm = matchFile("file:///a.py", "foo bar foo\nfoo", { pattern: "foo" }, "baz");
  assert.ok(fm);
  assert.equal(fm?.matches.length, 3);
  assert.equal(fm?.matches[0]?.id, "0:0");
  assert.equal(fm?.matches[1]?.id, "0:8");
  assert.equal(fm?.matches[2]?.id, "1:0");
  assert.equal(fm?.matches[0]?.replacement, "baz");
});

test("literal pattern with regex metachars is escaped (not interpreted)", () => {
  const fm = matchFile("file:///a.py", "a.b a_b axb", { pattern: "a.b" }, "X");
  assert.ok(fm);
  // only the literal "a.b" matches, not "a_b"/"axb".
  assert.equal(fm?.matches.length, 1);
  assert.equal(fm?.matches[0]?.matchText, "a.b");
});

test("regex match with group expansion in the replacement", () => {
  const fm = matchFile(
    "file:///a.ts",
    "const x = 1;\nconst y = 2;",
    { pattern: "const (\\w+)", isRegex: true },
    "let $1",
  );
  assert.ok(fm);
  assert.equal(fm?.matches.length, 2);
  assert.equal(fm?.matches[0]?.replacement, "let x");
  assert.equal(fm?.matches[1]?.replacement, "let y");
});

test("matchCase off is case-insensitive; on is exact", () => {
  const insensitive = matchFile("file:///a", "Foo foo FOO", { pattern: "foo" }, "x");
  assert.equal(insensitive?.matches.length, 3);
  const sensitive = matchFile("file:///a", "Foo foo FOO", { pattern: "foo", matchCase: true }, "x");
  assert.equal(sensitive?.matches.length, 1);
});

test("wholeWord only matches word-bounded occurrences", () => {
  const fm = matchFile("file:///a", "cat category cat", { pattern: "cat", wholeWord: true }, "dog");
  assert.equal(fm?.matches.length, 2); // "cat" twice, not inside "category"
});

test("empty pattern and invalid regex return null", () => {
  assert.equal(matchFile("file:///a", "x", { pattern: "" }, "y"), null);
  assert.equal(matchFile("file:///a", "x", { pattern: "(", isRegex: true }, "y"), null);
});

test("zero-width regex does not loop forever", () => {
  const fm = matchFile("file:///a", "abc", { pattern: "x*", isRegex: true }, "-");
  assert.ok(fm); // terminates; we don't assert the exact count, only that it returns.
});

test("applyReplacements writes ONLY accepted matches", () => {
  const fm = matchFile("file:///a", "foo foo foo", { pattern: "foo" }, "bar");
  assert.ok(fm);
  // accept only the first and third match (ids 0:0 and 0:8).
  const out = applyReplacements(fm!, ["0:0", "0:8"]);
  assert.equal(out, "bar foo bar");
});

test("applyReplacements with no acceptance is a no-op", () => {
  const fm = matchFile("file:///a", "foo", { pattern: "foo" }, "bar");
  assert.equal(applyReplacements(fm!, []), "foo");
});

test("applyReplacements right-to-left keeps columns valid for differing lengths", () => {
  // replacing "a"→"AAAA" twice on one line; right-to-left so the first splice
  // doesn't shift the second match's columns.
  const fm = matchFile("file:///a", "a-a", { pattern: "a" }, "AAAA");
  assert.ok(fm);
  const out = applyReplacements(fm!, allMatchIds(fm!));
  assert.equal(out, "AAAA-AAAA");
});

test("countMatches tallies matches and non-empty files", () => {
  const a = matchFile("file:///a", "foo foo", { pattern: "foo" }, "x")!;
  const b = matchFile("file:///b", "bar", { pattern: "foo" }, "x")!; // 0 matches
  const c = matchFile("file:///c", "foo", { pattern: "foo" }, "x")!;
  const { matches, files } = countMatches([a, b, c]);
  assert.equal(matches, 3);
  assert.equal(files, 2);
});

test("toggleMatch adds then removes an id", () => {
  let sel: string[] = [];
  sel = toggleMatch(sel, "0:0");
  assert.deepEqual(sel, ["0:0"]);
  sel = toggleMatch(sel, "0:0");
  assert.deepEqual(sel, []);
});

test("expandReplacement handles $$ and $0", () => {
  const m = /(\w+)@(\w+)/.exec("user@host") as RegExpExecArray;
  assert.equal(expandReplacement("$2:$1 cost $$5", m), "host:user cost $5");
  assert.equal(expandReplacement("[$0]", m), "[user@host]");
});

// ── APP-024: capture-substitution semantics (the exact JS-vs-PCRE decision) ──

test("expandReplacement: $& is the whole match; $` and $' stay LITERAL", () => {
  const m = /(\w+)@(\w+)/.exec("pre user@host post") as RegExpExecArray;
  assert.equal(expandReplacement("<$&>", m), "<user@host>");
  // no whole-string context in per-line splices → prefix/suffix refs pass through.
  assert.equal(expandReplacement("a$`b", m), "a$`b");
  assert.equal(expandReplacement("a$'b", m), "a$'b");
});

test("expandReplacement: two-digit groups use JS $nn-else-$n semantics", () => {
  const twelve = /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)/.exec("abcdefghijkl") as RegExpExecArray;
  assert.equal(expandReplacement("$12", twelve), "l"); // group 12 exists
  const two = /(x)(y)/.exec("xy") as RegExpExecArray;
  assert.equal(expandReplacement("$12", two), "x2"); // group 12 absent → $1 + "2"
  assert.equal(expandReplacement("$99", two), "$99"); // neither exists → literal
  assert.equal(expandReplacement("$9", two), "$9"); // out-of-range single stays literal
});

test("regex capture (\\w+) → $1_x substitutes groups per match (acceptance)", () => {
  const fm = matchFile("file:///a", "foo Bar", { pattern: "(\\w+)", isRegex: true }, "$1_x");
  assert.equal(fm?.matches.length, 2);
  assert.equal(fm?.matches[0]?.replacement, "foo_x");
  assert.equal(fm?.matches[1]?.replacement, "Bar_x");
  const out = applyReplacements(fm!, allMatchIds(fm!));
  assert.equal(out, "foo_x Bar_x");
});

test("case-insensitive capture keeps the MATCHED text's original casing", () => {
  const fm = matchFile(
    "file:///a",
    "MiXeD case",
    { pattern: "(mixed)", isRegex: true, matchCase: false },
    "$1_x",
  );
  assert.equal(fm?.matches[0]?.replacement, "MiXeD_x"); // $1 does NOT re-case
});

test("empty-match guard: `.*` on a non-empty line terminates with sane matches", () => {
  const fm = matchFile("file:///a", "abc", { pattern: ".*", isRegex: true }, "-");
  assert.ok(fm); // terminates (the zero-width lastIndex bump)
  // the full-line match is present exactly once; the trailing zero-width extra
  // (if any) is bounded — no hang, no unbounded growth.
  assert.ok(fm!.matches.length >= 1 && fm!.matches.length <= 2);
  assert.equal(fm!.matches[0]?.matchText, "abc");
});

// ── APP-024: stale-guarded fresh apply ───────────────────────────────────────

test("applyToFreshText applies on unchanged text and reports the applied count", () => {
  const fm = matchFile("file:///a", "foo bar foo", { pattern: "foo" }, "baz")!;
  const r = applyToFreshText(fm, allMatchIds(fm), "foo bar foo");
  assert.deepEqual(r, { ok: true, text: "baz bar baz", applied: 2 });
});

test("applyToFreshText tolerates an UNRELATED edit elsewhere in the file", () => {
  const fm = matchFile("file:///a", "keep\nfoo here", { pattern: "foo" }, "baz")!;
  // line 0 changed since preview; the match on line 1 is untouched → still applies.
  const r = applyToFreshText(fm, allMatchIds(fm), "kept!\nfoo here");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, "kept!\nbaz here");
});

test("applyToFreshText SKIPS the file when a match's own span drifted (stale)", () => {
  const fm = matchFile("file:///a", "foo bar", { pattern: "foo" }, "baz")!;
  const r = applyToFreshText(fm, allMatchIds(fm), "xfoo bar"); // span shifted
  assert.deepEqual(r, { ok: false, stale: 1 });
  const gone = applyToFreshText(fm, allMatchIds(fm), ""); // line vanished entirely
  assert.equal(gone.ok, false);
});

test("applyToFreshText with nothing accepted is a no-op on the CURRENT text", () => {
  const fm = matchFile("file:///a", "foo", { pattern: "foo" }, "baz")!;
  assert.deepEqual(applyToFreshText(fm, [], "current"), {
    ok: true,
    text: "current",
    applied: 0,
  });
});

// ── APP-024: required-literal extraction (regex → MAIN grep pre-filter) ─────

test("requiredLiteral finds the longest guaranteed literal run", () => {
  assert.equal(requiredLiteral("foo(\\w+)bar"), "foo");
  assert.equal(requiredLiteral("x(\\w+)longer"), "longer");
  assert.equal(requiredLiteral("hello"), "hello");
  assert.equal(requiredLiteral("import .* from"), "import "); // the literal space is required too
});

test("requiredLiteral is conservative: alternation/lookaround/backref → null", () => {
  assert.equal(requiredLiteral("foo|bar"), null);
  assert.equal(requiredLiteral("(?=foo)bar"), null);
  assert.equal(requiredLiteral("(foo)\\1"), null);
});

test("requiredLiteral translates control escapes; bails on operand escapes", () => {
  assert.equal(requiredLiteral("a\\tbcd"), "a\tbcd"); // \t is a REAL tab in the needle
  assert.equal(requiredLiteral("foo\\nbar"), "foo\nbar"); // sound for whole-file grep
  assert.equal(requiredLiteral("\\x41bcde"), null); // \xNN operands would be mis-read
  assert.equal(requiredLiteral("\\u0041bcde"), null);
  assert.equal(requiredLiteral("\\cAbcde"), null);
});

test("requiredLiteral drops optional units and respects escapes", () => {
  assert.equal(requiredLiteral("colou?r"), "colo"); // the 'u' is optional
  assert.equal(requiredLiteral("(abc)?xyz"), "xyz"); // optional group dropped whole
  assert.equal(requiredLiteral("ab+cde"), "cde"); // 'ab' kept but 'cde' is longer
  assert.equal(requiredLiteral("a\\.b\\$c"), "a.b$c"); // escaped literals join the run
  assert.equal(requiredLiteral("ab"), null); // under minLength
  assert.equal(requiredLiteral("\\d{4}-\\d{2}"), null); // no literal run ≥ 3
});

// ── APP-021: fused Search Everywhere ranking + tab model ─────────────────────

const R = (key: string, source: Ranked["source"], score: number): Ranked => ({
  key,
  source,
  score,
});

test("tabForMode maps the 4 legacy modes onto tabs (structure→symbols)", () => {
  assert.equal(tabForMode("commands"), "actions");
  assert.equal(tabForMode("files"), "files");
  assert.equal(tabForMode("symbols"), "symbols");
  assert.equal(tabForMode("structure"), "symbols");
  assert.equal(tabForMode("text"), "text");
  assert.equal(tabForMode("git"), "git");
  assert.equal(tabForMode("whatever"), "all");
});

test("cycleTab wraps forward and backward across all six tabs", () => {
  assert.equal(cycleTab("all", 1), "actions");
  assert.equal(cycleTab("git", 1), "all"); // wrap forward
  assert.equal(cycleTab("all", -1), "git"); // wrap backward
  assert.equal(cycleTab("actions", -1), "all");
});

test("fuseResults: empty source is ignored, over-cap source is capped", () => {
  const files = Array.from({ length: 20 }, (_, i) => R(`f${i}`, "files", 20 - i));
  const fused = fuseResults([[], files, []], "q");
  assert.equal(fused.length, 8); // files cap = 8
  assert.equal(
    fused.every((r) => r.source === "files"),
    true,
  );
  assert.equal(fused[0]?.key, "f0"); // highest score first
});

test("fuseResults: interleaves sources fairly (round-robin, not clustered)", () => {
  const actions = [R("a1", "actions", 100), R("a2", "actions", 90)];
  const files = [R("f1", "files", 5), R("f2", "files", 4)];
  const fused = fuseResults([actions, files], "q");
  // each source normalizes to [1,0]; round 1 takes both heads (a1,f1), round 2 (a2,f2).
  assert.deepEqual(
    fused.map((r) => r.key),
    ["a1", "f1", "a2", "f2"],
  );
});

test("fuseResults: min-max normalization makes disparate magnitudes comparable", () => {
  // symbols have huge raw scores, files tiny — after per-source normalization the top of
  // each source is 1.0, so both appear near the top rather than symbols dominating.
  const symbols = [R("s1", "symbols", 9999), R("s2", "symbols", 1)];
  const files = [R("x1", "files", 0.9), R("x2", "files", 0.1)];
  const fused = fuseResults([symbols, files], "q");
  assert.deepEqual(
    fused
      .slice(0, 2)
      .map((r) => r.key)
      .sort(),
    ["s1", "x1"],
  );
});

test("fuseResults: dedups by key (a file hit by both files + text keeps one)", () => {
  const files = [R("dup", "files", 5), R("f2", "files", 4)];
  const text = [R("dup", "text", 3)];
  const fused = fuseResults([files, text], "q");
  assert.equal(fused.filter((r) => r.key === "dup").length, 1);
});

test("fuseResults: single-item source (span 0) normalizes to 1 without NaN", () => {
  const fused = fuseResults([[R("only", "actions", 42)]], "q");
  assert.equal(fused.length, 1);
  assert.equal(fused[0]?.key, "only");
});

test("clipLineForDisplay: short line untouched", () => {
  const r = clipLineForDisplay("const x = 1", 6, 7);
  assert.equal(r.text, "const x = 1");
  assert.equal(r.start, 6);
  assert.equal(r.clippedLeft, false);
});

test("clipLineForDisplay: long line clips + shifts match offsets to the window", () => {
  const line = `${"a".repeat(300)}MATCH${"b".repeat(300)}`;
  const start = 300;
  const end = 305;
  const r = clipLineForDisplay(line, start, end, 200);
  assert.equal(r.text.length <= 200, true);
  // the shifted offsets still point at "MATCH" inside the clipped window.
  assert.equal(r.text.slice(r.start, r.end), "MATCH");
  assert.equal(r.clippedLeft, true);
});
