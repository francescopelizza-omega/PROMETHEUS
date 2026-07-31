/**
 * lint-store.test.ts — the PURE lint wire→row map + LSP/lint merge (APP-062).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProblemRow } from "./diagnostics.js";
import { type LintWireRow, lintWireToRow, mergeProblemRows } from "./lint-store.js";

const wire = (over: Partial<LintWireRow> = {}): LintWireRow => ({
  path: "/w/a.py",
  line: 3,
  col: 1,
  ruleId: "F401",
  tool: "ruff",
  severity: "warning",
  message: "unused import",
  ...over,
});

test("lintWireToRow: 1-based tool coords → 0-based; source=tool, code=ruleId → inspectionId tool:rule", () => {
  const r = lintWireToRow(wire());
  assert.equal(r.line, 2); // 3 → 0-based 2
  assert.equal(r.character, 0);
  assert.equal(r.severity, 2); // warning → LSP 2
  assert.equal(r.source, "ruff");
  assert.equal(r.code, "F401");
  assert.match(r.uri, /a\.py$/);
  // an error-severity finding maps to LSP 1.
  assert.equal(lintWireToRow(wire({ severity: "error" })).severity, 1);
});

test("mergeProblemRows: LSP wins a (uri,line,code) collision; unique lint rows are kept + sorted", () => {
  const lsp: ProblemRow[] = [
    {
      uri: "file:///w/a.py",
      name: "a.py",
      line: 2,
      character: 0,
      message: "lsp F401",
      severity: 1,
      source: "pyright",
      code: "F401",
    },
  ];
  const lint: ProblemRow[] = [
    // same uri+line+code as the LSP row → dropped (LSP kept)
    lintWireToRow(wire()),
    // a distinct rule on another line → kept
    lintWireToRow(wire({ line: 9, ruleId: "E501", message: "line too long" })),
  ];
  const merged = mergeProblemRows(lsp, lint);
  assert.equal(merged.length, 2);
  // the surviving F401 is the LSP one (message unchanged).
  const f401 = merged.find((r) => r.code === "F401");
  assert.equal(f401?.message, "lsp F401");
  assert.equal(f401?.source, "pyright");
  // the unique lint row survived.
  assert.ok(merged.some((r) => r.code === "E501"));
  // sorted by line.
  assert.deepEqual(
    merged.map((r) => r.line),
    [2, 8],
  );
});
