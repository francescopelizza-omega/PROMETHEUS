/**
 * quick-doc.test.ts — the pure Quick Doc / docstring-stub / reader-mode helpers (APP-098):
 * every hover content shape, https link extraction + host allowlist, python + JSDoc stubs,
 * unknown-language null fallback, and doc-comment range detection. node:test, no Electron/DOM.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { NormalizedSymbol } from "./lsp-convert.ts";
import {
  buildDocstringStub,
  classifyLink,
  docCommentRanges,
  enclosingFunction,
  hoverToDoc,
  lspContentsToMarkdown,
  parseParamNames,
} from "./quick-doc.ts";

test("lspContentsToMarkdown flattens all four hover content shapes", () => {
  assert.deepEqual(lspContentsToMarkdown("plain"), ["plain"]);
  assert.deepEqual(lspContentsToMarkdown({ language: "python", value: "def f(): ..." }), [
    "```python\ndef f(): ...\n```",
  ]);
  assert.deepEqual(lspContentsToMarkdown({ kind: "markdown", value: "**docs**" }), ["**docs**"]);
  assert.deepEqual(lspContentsToMarkdown([{ language: "ts", value: "x: number" }, "prose"]), [
    "```ts\nx: number\n```",
    "prose",
  ]);
  assert.deepEqual(lspContentsToMarkdown(null), []);
  assert.deepEqual(lspContentsToMarkdown([null, "", "keep"]), ["keep"]);
});

test("hoverToDoc splits signature from prose and returns null when empty", () => {
  const doc = hoverToDoc([
    { language: "python", value: "def area(r: float) -> float" },
    "Compute the area. See https://docs.python.org/3/library/math.html for details.",
  ]);
  assert.ok(doc);
  assert.equal(doc.signature, "def area(r: float) -> float");
  assert.match(doc.markdown, /Compute the area/);
  assert.equal(doc.links.length, 1);
  assert.equal(doc.links[0]?.host, "docs.python.org");
  assert.equal(doc.links[0]?.allowed, true);

  assert.equal(hoverToDoc(null), null);
  assert.equal(hoverToDoc([]), null);
});

test("hoverToDoc trims punctuation glued to a URL and dedupes", () => {
  const doc = hoverToDoc(["see https://example.com/a. and https://example.com/a again"]);
  assert.ok(doc);
  assert.deepEqual(
    doc.links.map((l) => l.url),
    ["https://example.com/a"],
  );
});

test("classifyLink: allowlisted host (and subdomain) openable; others inert; junk safe-fails", () => {
  assert.equal(classifyLink("https://docs.python.org/3/").allowed, true);
  assert.equal(classifyLink("https://api.github.com/x").allowed, true); // subdomain of github.com
  assert.equal(classifyLink("https://evil.example.com/x").allowed, false);
  assert.equal(classifyLink("not a url").allowed, false);
});

test("buildDocstringStub: python triple-quoted with Args/Returns", () => {
  const stub = buildDocstringStub({
    languageId: "python",
    name: "area",
    params: [{ name: "r" }, { name: "unit" }],
    returns: true,
  });
  assert.equal(
    stub,
    ['"""Summary.', "", "Args:", "    r: ", "    unit: ", "", "Returns:", "    ", '"""'].join("\n"),
  );
});

test("buildDocstringStub: python with no params/returns collapses cleanly", () => {
  assert.equal(
    buildDocstringStub({ languageId: "python", name: "f", params: [] }),
    '"""Summary."""',
  );
});

test("buildDocstringStub: JSDoc block for ts/js with @param/@returns", () => {
  const stub = buildDocstringStub({
    languageId: "typescript",
    name: "area",
    params: [{ name: "r" }],
    returns: true,
  });
  assert.equal(stub, ["/**", " * Summary.", " * @param r", " * @returns", " */"].join("\n"));
});

test("buildDocstringStub: unknown language → null", () => {
  assert.equal(buildDocstringStub({ languageId: "rust", name: "f", params: [] }), null);
});

test("docCommentRanges: JSDoc blocks (multi + single line)", () => {
  const lines = ["/**", " * doc", " */", "function f() {}", "/** one-liner */", "const x = 1;"];
  assert.deepEqual(docCommentRanges(lines, "typescript"), [
    { startLine: 0, endLine: 2 },
    { startLine: 4, endLine: 4 },
  ]);
});

test("parseParamNames: strips types/defaults, drops self/cls for python, handles nesting", () => {
  assert.deepEqual(
    parseParamNames("(r: float, unit: str = 'm')", "python").map((p) => p.name),
    ["r", "unit"],
  );
  assert.deepEqual(
    parseParamNames("area(self, r: float)", "python").map((p) => p.name),
    ["r"], // self skipped
  );
  assert.deepEqual(
    parseParamNames("(a: Map<string, number>, b: () => void)", "typescript").map((p) => p.name),
    ["a", "b"], // top-level comma split ignores the nested generic/arrow commas
  );
  // a param AFTER an arrow-typed param must NOT be dropped (the `>` in `=>` used to drive depth
  // negative so the following top-level comma never split).
  assert.deepEqual(
    parseParamNames("(cb: () => void, x: number)", "typescript").map((p) => p.name),
    ["cb", "x"],
  );
  assert.deepEqual(parseParamNames("noParens", "typescript"), []);
  assert.deepEqual(parseParamNames("f()", "python"), []);
});

test("enclosingFunction: deepest callable containing the caret, else null", () => {
  const R = (sl: number, el: number) => ({
    start: { line: sl, character: 0 },
    end: { line: el, character: 0 },
  });
  const sym = (
    name: string,
    kind: number,
    r: ReturnType<typeof R>,
    children: NormalizedSymbol[] = [],
  ): NormalizedSymbol => ({
    name,
    detail: "",
    kind,
    range: r,
    selectionRange: r,
    children,
  });
  // class Foo (0-9) { method bar (2-5) { nested var (3-3) } }
  const tree = [sym("Foo", 5, R(0, 9), [sym("bar", 6, R(2, 5), [sym("x", 13, R(3, 3))])])];
  assert.equal(enclosingFunction(tree, 3, 0)?.name, "bar"); // inside a var but the callable is bar
  assert.equal(enclosingFunction(tree, 4, 0)?.name, "bar");
  assert.equal(enclosingFunction(tree, 1, 0), null); // in the class, not a method
  assert.equal(enclosingFunction(tree, 20, 0), null);
});

test("docCommentRanges: python docstrings (triple-quote blocks)", () => {
  const lines = ["def f():", '    """', "    docs", '    """', "    return 1", '    """x"""'];
  assert.deepEqual(docCommentRanges(lines, "python"), [
    { startLine: 1, endLine: 3 },
    { startLine: 5, endLine: 5 },
  ]);
  // unknown language → no ranges.
  assert.deepEqual(docCommentRanges(lines, "rust"), []);
});
