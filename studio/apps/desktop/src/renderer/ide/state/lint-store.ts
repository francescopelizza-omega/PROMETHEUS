/**
 * ide/state/lint-store.ts — the linter fan-in diagnostics slice (APP-062).
 *
 * Holds the last `ide:lintRun` result (ruff/flake8/mypy/pylint findings, already normalized
 * by the linters.py sidecar) as ProblemRow objects so the Problems panel can MERGE them with
 * the live LSP diagnostics through the SAME inspection-profile projection. A lint row's
 * `source` is its TOOL (ruff/mypy/…) and `code` its ruleId, so `inspectionId` = `tool:ruleId`
 * — a per-rule severity-raise on ruff's F401 can't also re-rank flake8's.
 *
 * The wire→row map + the LSP/lint merge (dedupe by path+line+ruleId) are PURE + node:test-ed;
 * only the zustand holder is glue.
 */
import { create } from "zustand";

import { pathToFileUri } from "./breakpoint-store.js";
import type { DiagnosticSeverity, ProblemRow } from "./diagnostics.js";
import { type Severity, severityToLsp } from "./inspection-profile.js";

/** One normalized finding as the linters.py sidecar emits it. */
export interface LintWireRow {
  path: string;
  line: number; // 1-based (tool convention)
  col: number; // 1-based
  ruleId: string;
  tool: string;
  severity: string; // "error" | "warning" | "info" | "hint"
  message: string;
}

/** A tool that was skipped this run (not installed, timed out, internal error). */
export interface LintSkip {
  tool: string;
  reason: string;
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

/** Map one sidecar wire finding → a ProblemRow (0-based line/char; source=tool, code=ruleId). */
export function lintWireToRow(w: LintWireRow): ProblemRow {
  return {
    uri: pathToFileUri(w.path),
    name: basename(w.path),
    line: Math.max(0, (w.line || 1) - 1),
    character: Math.max(0, (w.col || 1) - 1),
    message: w.message,
    severity: (severityToLsp(w.severity as Severity) ?? 2) as DiagnosticSeverity,
    source: w.tool,
    code: w.ruleId,
  };
}

/**
 * Merge lint rows into LSP rows, DE-DUPING by (uri, line, code) — the LSP row wins (kept),
 * since ruff/flake8 re-implement many pyright/pyflakes codes on the same line. Sorted by
 * location (uri, line, character) like toProblemRows so the merged list reads coherently.
 */
export function mergeProblemRows(
  lsp: readonly ProblemRow[],
  lint: readonly ProblemRow[],
): ProblemRow[] {
  const key = (r: ProblemRow): string => `${r.uri}|${r.line}|${r.code ?? ""}`;
  const seen = new Set(lsp.map(key));
  const out = [...lsp];
  for (const r of lint) {
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    out.push(r);
  }
  return out.sort(
    (a, b) => a.uri.localeCompare(b.uri) || a.line - b.line || a.character - b.character,
  );
}

interface LintStore {
  rows: ProblemRow[];
  ran: string[];
  skipped: LintSkip[];
  /** the toUri map so paths resolve to the same file:// uris the tabs use. */
  setResults(wire: LintWireRow[], ran: string[], skipped: LintSkip[]): void;
  clear(): void;
}

export const useLintStore = create<LintStore>((set) => ({
  rows: [],
  ran: [],
  skipped: [],
  setResults: (wire, ran, skipped) => set({ rows: wire.map(lintWireToRow), ran, skipped }),
  clear: () => set({ rows: [], ran: [], skipped: [] }),
}));
