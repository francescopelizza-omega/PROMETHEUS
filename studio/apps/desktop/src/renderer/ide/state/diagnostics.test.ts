/**
 * diagnostics.test.ts — node:test for the PURE LSP-diagnostics aggregate (§3.3/§11).
 *
 * Pins the per-uri authoritative replace (publishDiagnostics), the flat Problems
 * projection sorted by location, and the error/warning tallies the status spine
 * shows. Pure — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Diagnostic,
  type DiagnosticsByUri,
  clearDiagnostics,
  countDiagnostics,
  diagnosticsSummary,
  setDiagnostics,
  toProblemRows,
} from "./diagnostics.js";

function diag(
  line: number,
  char: number,
  message: string,
  severity: 1 | 2 | 3 | 4 = 1,
): Diagnostic {
  return {
    range: { start: { line, character: char }, end: { line, character: char + 1 } },
    message,
    severity,
  };
}

test("setDiagnostics replaces a uri's list (publishDiagnostics is authoritative)", () => {
  let s: DiagnosticsByUri = {};
  s = setDiagnostics(s, "file:///a.py", [diag(1, 0, "first")]);
  assert.equal(s["file:///a.py"]?.length, 1);
  s = setDiagnostics(s, "file:///a.py", [diag(2, 0, "x"), diag(3, 0, "y")]);
  assert.equal(s["file:///a.py"]?.length, 2);
});

test("setDiagnostics with an empty list drops the uri (cleared)", () => {
  let s: DiagnosticsByUri = setDiagnostics({}, "file:///a.py", [diag(1, 0, "x")]);
  s = setDiagnostics(s, "file:///a.py", []);
  assert.equal("file:///a.py" in s, false);
});

test("clearDiagnostics removes a uri (file closed)", () => {
  let s = setDiagnostics({}, "file:///a.py", [diag(1, 0, "x")]);
  s = clearDiagnostics(s, "file:///a.py");
  assert.deepEqual(s, {});
});

test("toProblemRows sorts by uri, then line, then column", () => {
  let s: DiagnosticsByUri = {};
  s = setDiagnostics(s, "file:///b.py", [diag(0, 5, "b-l0c5"), diag(0, 1, "b-l0c1")]);
  s = setDiagnostics(s, "file:///a.py", [diag(2, 0, "a-l2")]);
  const rows = toProblemRows(s);
  assert.deepEqual(
    rows.map((r) => r.message),
    ["a-l2", "b-l0c1", "b-l0c5"],
  );
  assert.equal(rows[0]?.name, "a.py");
});

test("countDiagnostics tallies severities", () => {
  let s: DiagnosticsByUri = {};
  s = setDiagnostics(s, "file:///a", [diag(0, 0, "e", 1), diag(1, 0, "w", 2), diag(2, 0, "i", 3)]);
  s = setDiagnostics(s, "file:///b", [diag(0, 0, "e2", 1), diag(1, 0, "h", 4)]);
  const c = countDiagnostics(s);
  assert.deepEqual(c, { errors: 2, warnings: 1, infos: 1, hints: 1, total: 5 });
});

test("absent severity defaults to Error (fail loud)", () => {
  const s = setDiagnostics({}, "file:///a", [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "x" },
  ]);
  assert.equal(countDiagnostics(s).errors, 1);
});

test("diagnosticsSummary is empty when clean and shows counts otherwise", () => {
  assert.equal(diagnosticsSummary({ errors: 0, warnings: 0, infos: 0, hints: 0, total: 0 }), "");
  assert.equal(
    diagnosticsSummary({ errors: 2, warnings: 3, infos: 0, hints: 0, total: 5 }),
    "2 ✖ · 3 ⚠",
  );
});
