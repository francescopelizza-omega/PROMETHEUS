/**
 * highlight.test.ts — the stateful syntax highlighter.
 *
 * Invariants under test: join(tokens.text) === line (byte-preservation), caps='none' is a pure
 * identity (zero escape bytes), multiline constructs carry state across lines, and role mapping.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CODE_STATE,
  detectLanguage,
  highlightLine,
  isHighlightable,
  tokenizeLine,
} from "./highlight.js";

const roleOf = (line: string, lang: string, text: string): string | undefined =>
  tokenizeLine(line, lang).tokens.find((t) => t.text === text)?.role;

const joins = (line: string, lang: string): boolean =>
  tokenizeLine(line, lang)
    .tokens.map((t) => t.text)
    .join("") === line;

/* ── byte-preservation (the cardinal invariant) ─────────────────────────────── */

test("join(tokens) === line across languages and tricky lines", () => {
  const cases: Array<[string, string]> = [
    ["const x = `t${a}`; // c", "js"],
    ["def f(a, b):  # comment", "python"],
    ['  "key": [1, 2, 3],', "json"],
    ["port = 8080 # inline", "toml"],
    ["for i in $(seq 1 3); do echo $i; done", "bash"],
    ["    return  1.5e-3 + 0xFF", "js"],
    ["", "js"],
    ["\t\t", "python"],
    ["émoji → 日本語 test", "js"],
  ];
  for (const [line, lang] of cases) assert.ok(joins(line, lang), `join failed: ${lang} :: ${line}`);
});

/* ── caps='none' is identity (zero escapes) ─────────────────────────────────── */

test("highlightLine at caps='none' returns the line unchanged (no escapes)", () => {
  const { text } = highlightLine("const x = 1;", "js", CODE_STATE, "none");
  assert.equal(text, "const x = 1;");
  assert.ok(!text.includes("\x1b"));
});

test("highlightLine at truecolor paints (has escapes) but preserves visible text", () => {
  const { text } = highlightLine("const x = 1;", "js", CODE_STATE, "truecolor");
  assert.ok(text.includes("\x1b"));
  assert.equal(text.replace(/\x1b\[[0-9;]*m/g, ""), "const x = 1;");
});

/* ── role mapping ───────────────────────────────────────────────────────────── */

test("js: keyword / number / comment / string / function roles", () => {
  assert.equal(roleOf("const x = 1 // hi", "js", "const"), "synKeyword");
  assert.equal(roleOf("const x = 1 // hi", "js", "1"), "synNumber");
  assert.equal(roleOf("const x = 1 // hi", "js", "// hi"), "synComment");
  assert.equal(roleOf('let s = "hey"', "js", '"hey"'), "synString");
  assert.equal(roleOf("foo(1)", "js", "foo"), "synFunc");
});

test("json: a string before ':' is a property, the value string is a string", () => {
  assert.equal(roleOf('"key": "val"', "json", '"key"'), "synProperty");
  assert.equal(roleOf('"key": "val"', "json", '"val"'), "synString");
});

/* ── multiline state carry ──────────────────────────────────────────────────── */

test("block comment /* */ carries across lines", () => {
  const a = tokenizeLine("code /* open", "js", CODE_STATE);
  assert.equal(a.state.mode, "block");
  const b = tokenizeLine("still comment", "js", a.state);
  assert.equal(b.state.mode, "block");
  assert.equal(b.tokens[0]?.role, "synComment");
  const c = tokenizeLine("close */ x", "js", b.state);
  assert.equal(c.state.mode, "code");
  assert.equal(c.tokens[0]?.role, "synComment");
  assert.equal(c.tokens.map((t) => t.text).join(""), "close */ x");
});

test("python triple-quote carries across lines", () => {
  const a = tokenizeLine('doc = """start', "python", CODE_STATE);
  assert.equal(a.state.mode, "triple");
  const b = tokenizeLine("middle", "python", a.state);
  assert.equal(b.state.mode, "triple");
  const c = tokenizeLine('end"""', "python", b.state);
  assert.equal(c.state.mode, "code");
});

/* ── language detection + unknown fail-closed ───────────────────────────────── */

test("detectLanguage canonicalizes aliases, unknown → plain", () => {
  assert.equal(detectLanguage("javascript"), "js");
  assert.equal(detectLanguage("TS"), "ts");
  assert.equal(detectLanguage("py"), "python");
  assert.equal(detectLanguage("shell"), "bash");
  assert.equal(detectLanguage("rust"), "c");
  assert.equal(detectLanguage("mermaid"), "plain");
  assert.equal(detectLanguage(""), "plain");
  assert.equal(detectLanguage(undefined), "plain");
});

test("unknown lang is not highlightable and highlightLine is identity", () => {
  assert.equal(isHighlightable("plain"), false);
  const { text } = highlightLine("whatever { }", "plain", CODE_STATE, "truecolor");
  assert.equal(text, "whatever { }");
});
