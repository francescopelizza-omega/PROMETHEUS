/**
 * lsp-convert.test.ts — node:test for the PURE LSP↔Monaco converters (leap #3).
 *
 * Pins the 0↔1-based position math, the kind-enum name mapping (the easy-to-misalign
 * part), and the defensive normalizers that must accept BOTH union forms (Location vs
 * LocationLink, hierarchical DocumentSymbol vs flat SymbolInformation) and drop garbage
 * without throwing. Pure — no monaco — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  docToMarkdown,
  isSnippet,
  monacoCompletionKind,
  monacoSymbolKind,
  normalizeLocations,
  normalizeSymbols,
  normalizeTextEdits,
  toLspPosition,
  toLspRange,
} from "./lsp-convert.js";

test("position/range math is 1-based monaco → 0-based LSP", () => {
  assert.deepEqual(toLspPosition({ lineNumber: 1, column: 1 }), { line: 0, character: 0 });
  assert.deepEqual(
    toLspRange({ startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 9 }),
    { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
  );
});

test("completion kind maps by name with a Text fallback", () => {
  const K = { Text: 18, Function: 1, Snippet: 27 };
  assert.equal(monacoCompletionKind(K, 3), 1); // LSP Function → Monaco Function
  assert.equal(monacoCompletionKind(K, 15), 27); // LSP Snippet → Monaco Snippet
  assert.equal(monacoCompletionKind(K, 999), 18); // out of range → Text
  assert.equal(monacoCompletionKind(K, undefined), 18); // missing → Text
});

test("symbol kind maps by name with a Variable fallback", () => {
  const K = { Variable: 12, Class: 4, Function: 11 };
  assert.equal(monacoSymbolKind(K, 5), 4); // LSP Class → Monaco Class
  assert.equal(monacoSymbolKind(K, 12), 11); // LSP Function → Monaco Function
  assert.equal(monacoSymbolKind(K, 0), 12); // 0 invalid → Variable
});

test("isSnippet only for insertTextFormat === 2", () => {
  assert.equal(isSnippet(2), true);
  assert.equal(isSnippet(1), false);
  assert.equal(isSnippet(undefined), false);
});

test("normalizeLocations accepts Location, Location[], and LocationLink", () => {
  const r = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
  // single Location
  assert.deepEqual(normalizeLocations({ uri: "file:///a.py", range: r }), [
    { uri: "file:///a.py", range: r },
  ]);
  // LocationLink (targetUri + targetSelectionRange wins over targetRange)
  const link = { targetUri: "file:///b.py", targetRange: r, targetSelectionRange: r };
  assert.deepEqual(normalizeLocations([link]), [{ uri: "file:///b.py", range: r }]);
  // garbage dropped, not thrown
  assert.deepEqual(normalizeLocations([null, { uri: 5 }, {}]), []);
  assert.deepEqual(normalizeLocations(null), []);
});

test("normalizeTextEdits keeps valid edits, coerces newText, drops malformed", () => {
  const r = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  assert.deepEqual(normalizeTextEdits([{ range: r, newText: "x" }, { range: r }, { bad: 1 }]), [
    { range: r, newText: "x" },
    { range: r, newText: "" },
  ]);
  assert.deepEqual(normalizeTextEdits("nope"), []);
});

test("normalizeSymbols handles hierarchical AND flat, recursing children", () => {
  const r = { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } };
  const sel = { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } };
  const hierarchical = [
    {
      name: "Foo",
      kind: 5,
      range: r,
      selectionRange: sel,
      children: [{ name: "bar", kind: 6, range: r, selectionRange: sel }],
    },
  ];
  const out = normalizeSymbols(hierarchical);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.name, "Foo");
  assert.equal(out[0]?.children.length, 1);
  assert.equal(out[0]?.children[0]?.name, "bar");

  // flat SymbolInformation → location.range lifted, containerName → detail
  const flat = [
    { name: "g", kind: 12, location: { uri: "file:///a", range: r }, containerName: "mod" },
  ];
  const fout = normalizeSymbols(flat);
  assert.equal(fout[0]?.name, "g");
  assert.equal(fout[0]?.detail, "mod");
  assert.deepEqual(fout[0]?.range, r);
});

test("docToMarkdown flattens string and MarkupContent", () => {
  assert.equal(docToMarkdown("hi"), "hi");
  assert.equal(docToMarkdown({ kind: "markdown", value: "**b**" }), "**b**");
  assert.equal(docToMarkdown(undefined), "");
  assert.equal(docToMarkdown(42), "");
});
