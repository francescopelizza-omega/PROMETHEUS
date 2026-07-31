/**
 * editorconfig.test.ts — node:test for the PURE `.editorconfig` resolver (APP-019).
 * Pins the parser, the editorconfig-core glob subset, root=true stop, nearest-file /
 * last-section precedence, value normalization, and the save-time text transforms.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type EditorConfigEntry,
  applyEditorConfigTextRules,
  editorConfigMatches,
  parseEditorConfig,
  resolveEditorConfig,
} from "./editorconfig.js";

/* ── parsing ────────────────────────────────────────────────────────────────── */

test("parseEditorConfig reads root + sections + props, skips comments/blanks", () => {
  const p = parseEditorConfig(
    [
      "root = true",
      "",
      "# a comment",
      "; another",
      "[*]",
      "indent_size = 2",
      "[*.py]",
      "indent_size=4",
    ].join("\n"),
  );
  assert.equal(p.root, true);
  assert.equal(p.sections.length, 2);
  assert.deepEqual(p.sections[0], { pattern: "*", props: { indent_size: "2" } });
  assert.deepEqual(p.sections[1], { pattern: "*.py", props: { indent_size: "4" } });
});

test("parseEditorConfig: root only counts in the preamble, keys lowercased", () => {
  const p = parseEditorConfig(["[*]", "root = true", "Indent_Style = Tab"].join("\n"));
  assert.equal(p.root, false); // `root` under a section is just a (ignored) prop key
  assert.equal(p.sections[0]?.props.indent_style, "Tab");
});

/* ── glob matching (the required editorconfig-core cases) ───────────────────── */

test("editorConfigMatches: * does not cross /, no-slash matches any depth", () => {
  assert.equal(editorConfigMatches("*.py", "a.py"), true);
  assert.equal(editorConfigMatches("*.py", "src/deep/a.py"), true); // any depth
  assert.equal(editorConfigMatches("*.py", "a.pyc"), false);
});

test("editorConfigMatches: *.{js,ts} brace alternation", () => {
  assert.equal(editorConfigMatches("*.{js,ts}", "a.js"), true);
  assert.equal(editorConfigMatches("*.{js,ts}", "a.ts"), true);
  assert.equal(editorConfigMatches("*.{js,ts}", "a.tsx"), false);
});

test("editorConfigMatches: **/lib/*.py crosses directories", () => {
  assert.equal(editorConfigMatches("**/lib/*.py", "lib/x.py"), true);
  assert.equal(editorConfigMatches("**/lib/*.py", "a/b/lib/x.py"), true);
  assert.equal(editorConfigMatches("**/lib/*.py", "lib/sub/x.py"), false); // * stops at /
});

test("editorConfigMatches: an embedded / anchors to the config dir", () => {
  assert.equal(editorConfigMatches("src/*.py", "src/a.py"), true);
  assert.equal(editorConfigMatches("src/*.py", "x/src/a.py"), false); // not any-depth
  assert.equal(editorConfigMatches("/src/*.py", "src/a.py"), true); // leading / == anchored
});

test("editorConfigMatches: [] classes (incl. negation) and {n..m} ranges", () => {
  assert.equal(editorConfigMatches("*.[ch]", "a.c"), true);
  assert.equal(editorConfigMatches("*.[ch]", "a.h"), true);
  assert.equal(editorConfigMatches("*.[!ch]", "a.c"), false);
  assert.equal(editorConfigMatches("*.[!ch]", "a.d"), true);
  assert.equal(editorConfigMatches("file{1..3}.txt", "file2.txt"), true);
  assert.equal(editorConfigMatches("file{1..3}.txt", "file4.txt"), false);
  assert.equal(editorConfigMatches("f?o.txt", "foo.txt"), true);
  assert.equal(editorConfigMatches("f?o.txt", "fo.txt"), false);
});

/* ── resolution: precedence + root stop + normalization ────────────────────── */

function entry(dir: string, text: string): EditorConfigEntry {
  return { dir, parsed: parseEditorConfig(text) };
}

test("resolveEditorConfig: last matching section in a file wins", () => {
  const chain = [entry("/w", ["[*]", "indent_size = 2", "[*.py]", "indent_size = 4"].join("\n"))];
  assert.equal(resolveEditorConfig(chain, "/w/a.py").indentSize, 4);
  assert.equal(resolveEditorConfig(chain, "/w/a.js").indentSize, 2);
});

test("resolveEditorConfig: nearer .editorconfig overrides an ancestor", () => {
  const chain = [
    entry("/w/src", ["[*]", "indent_size = 2"].join("\n")), // nearest
    entry("/w", ["[*]", "indent_size = 8", "insert_final_newline = true"].join("\n")),
  ];
  const r = resolveEditorConfig(chain, "/w/src/a.py");
  assert.equal(r.indentSize, 2); // child dir wins for indent_size
  assert.equal(r.insertFinalNewline, true); // ancestor-only key still resolves
});

test("resolveEditorConfig: root=true stops the parent walk", () => {
  const chain = [
    entry("/w/src", ["root = true", "[*]", "indent_size = 2"].join("\n")),
    entry("/w", ["[*]", "indent_size = 8", "charset = utf-8"].join("\n")), // must be ignored
  ];
  const r = resolveEditorConfig(chain, "/w/src/a.py");
  assert.equal(r.indentSize, 2);
  assert.equal(r.charset, undefined); // ancestor beyond root=true is not read
});

test("resolveEditorConfig: value normalization (tab, eol, booleans, unset)", () => {
  const chain = [
    entry(
      "/w",
      [
        "[*]",
        "indent_style = tab",
        "tab_width = 4",
        "end_of_line = crlf",
        "trim_trailing_whitespace = true",
        "insert_final_newline = false",
        "charset = utf-8",
        "[*.md]",
        "indent_size = unset",
      ].join("\n"),
    ),
  ];
  const r = resolveEditorConfig(chain, "/w/x.ts");
  assert.equal(r.indentStyle, "tab");
  assert.equal(r.tabWidth, 4);
  assert.equal(r.indentSize, 4); // tab indent mirrors tab_width
  assert.equal(r.endOfLine, "crlf");
  assert.equal(r.trimTrailingWhitespace, true);
  assert.equal(r.insertFinalNewline, false);
  assert.equal(r.charset, "utf-8");
  // `indent_size = unset` on *.md leaves indent_size at the editor default (undefined),
  // while the *-section tab-mirror does not apply (indent_style there is still tab...).
  const md = resolveEditorConfig(chain, "/w/x.md");
  assert.equal(md.indentSize, 4); // *.md only unsets indent_size; * still gives tab→4
});

/* ── save-time text transforms ─────────────────────────────────────────────── */

test("applyEditorConfigTextRules: trim + final newline + eol", () => {
  const trimmed = applyEditorConfigTextRules("a  \nb\t\n", { trimTrailingWhitespace: true });
  assert.equal(trimmed, "a\nb\n");
  assert.equal(applyEditorConfigTextRules("a\nb", { insertFinalNewline: true }), "a\nb\n");
  assert.equal(applyEditorConfigTextRules("a\nb\n\n", { insertFinalNewline: false }), "a\nb");
  assert.equal(applyEditorConfigTextRules("a\nb\n", { endOfLine: "crlf" }), "a\r\nb\r\n");
  assert.equal(applyEditorConfigTextRules("a\r\nb\r\n", { endOfLine: "lf" }), "a\nb\n");
});

test("applyEditorConfigTextRules: empty rules leave text byte-identical", () => {
  const s = "keep  \nas-is\r\n";
  assert.equal(applyEditorConfigTextRules(s, {}), s);
});

/* ── hardening: DoS cap + spec-correct braces/classes (APP-019 review) ───────── */

test("editorConfigMatches: a huge {n..m} range does NOT enumerate (DoS guard)", () => {
  const t0 = Date.now();
  // an untrusted `.editorconfig` could carry this — must resolve instantly, not OOM.
  assert.equal(editorConfigMatches("{0..500000000}.txt", "42.txt"), true);
  assert.equal(editorConfigMatches("{0..500000000}.txt", "x.txt"), false);
  assert.ok(Date.now() - t0 < 250, "huge range must not block the thread");
  // small ranges stay EXACT (bounded alternation, not the loose fallback).
  assert.equal(editorConfigMatches("file{1..3}.txt", "file2.txt"), true);
  assert.equal(editorConfigMatches("file{1..3}.txt", "file4.txt"), false);
});

test("editorConfigMatches: comma-less / empty brace groups are LITERAL (spec)", () => {
  assert.equal(editorConfigMatches("{single}.b", "{single}.b"), true);
  assert.equal(editorConfigMatches("{single}.b", "single.b"), false);
  assert.equal(editorConfigMatches("{}.c", "{}.c"), true);
  assert.equal(editorConfigMatches("{}.c", ".c"), false);
});

test("editorConfigMatches: a leading `^` in [..] is a literal member, not negation", () => {
  assert.equal(editorConfigMatches("[^x].js", "x.js"), true); // ^ and x are both members
  assert.equal(editorConfigMatches("[^x].js", "^.js"), true);
  assert.equal(editorConfigMatches("[^x].js", "a.js"), false);
  // `!` is still the only negation form.
  assert.equal(editorConfigMatches("[!x].js", "x.js"), false);
  assert.equal(editorConfigMatches("[!x].js", "a.js"), true);
});
