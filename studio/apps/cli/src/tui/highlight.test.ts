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

/* ── Pelly scheme: fine Python roles (self / class / func / brackets / dot / const / docstring) ── */

test("python: self, class name, func name, brackets, dot, constant, decorator, docstring roles", () => {
  const roleOf = (line: string, needle: string): string | undefined =>
    tokenizeLine(line, "python").tokens.find((t) => t.text === needle)?.role;

  assert.equal(roleOf("def fibonacci(self, n):", "self"), "synSelf");
  assert.equal(roleOf("def fibonacci(self, n):", "fibonacci"), "synFunc");
  assert.equal(roleOf("def fibonacci(self, n):", "def"), "synKeyword");
  assert.equal(roleOf("class MathSolver:", "MathSolver"), "synClass");
  assert.equal(roleOf("seq[-1]", "["), "synBracket");
  assert.equal(roleOf("seq[-1]", "]"), "synBracket");
  assert.equal(roleOf("f(a, b)", "("), "synParen");
  assert.equal(roleOf("f(a, b)", ","), "synComma");
  assert.equal(roleOf("d = {1: 2}", "{"), "synBrace");
  assert.equal(roleOf("obj.attr", "."), "synDot");
  assert.equal(roleOf("MAX_SIZE = 100", "MAX_SIZE"), "synConstant");
  assert.equal(roleOf("print(x)", "print"), "synBuiltin");
  assert.equal(tokenizeLine("@staticmethod", "python").tokens[0]?.role, "synDecorator");
});

test("python: a triple-quote at statement start is a docstring (synDoc), mid-line is a string", () => {
  assert.equal(
    tokenizeLine('    """doc."""', "python").tokens.find((t) => t.text.includes("doc"))?.role,
    "synDoc",
  );
  // carried across lines
  const open = tokenizeLine('    """multi', "python");
  assert.equal(open.state.role, "synDoc");
  const mid = tokenizeLine("still doc", "python", open.state);
  assert.equal(mid.tokens[0]?.role, "synDoc");
  // an assignment triple is a normal string, not a docstring
  assert.equal(
    tokenizeLine('x = """v"""', "python").tokens.find((t) => t.text.includes("v"))?.role,
    "synString",
  );
});

test("byte-invariant holds for a dense Pelly line (join === line)", () => {
  const line = "        return sequence[-1] + self.calc(n, base=2)  # note";
  const { tokens } = tokenizeLine(line, "python");
  assert.equal(tokens.map((t) => t.text).join(""), line);
});
