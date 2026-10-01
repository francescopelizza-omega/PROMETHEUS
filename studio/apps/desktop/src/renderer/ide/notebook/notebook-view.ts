// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * notebook-view.ts — PURE notebook cell-list reducer (file 14 §3.25).
 *
 * The Monaco-multicell notebook editor's cell-list logic, decoupled from React/Monaco
 * so it's node:test-tested. Kernel execution (kernel.py via jupyter_client) is a
 * supervised runtime seam (C8); this models the cells + their execution status only.
 */

export type CellKind = "code" | "markdown";
export type ExecStatus = "idle" | "running" | "ok" | "error";

/** One notebook cell. */
export interface Cell {
  id: string;
  kind: CellKind;
  source: string;
  language?: string;
  status: ExecStatus;
  /** rich outputs from the kernel (text/image/html), rendered sandboxed. */
  outputs?: { mime: string; data: string }[];
  /** execution count (Jupyter [n]). */
  execCount?: number;
}

export type NotebookAction =
  | { type: "add"; id: string; kind?: CellKind; afterId?: string; source?: string }
  | { type: "remove"; id: string }
  | { type: "update"; id: string; source: string }
  | { type: "run-start"; id: string }
  | { type: "append-output"; id: string; output: { mime: string; data: string } }
  | { type: "run-ok"; id: string; outputs?: Cell["outputs"]; execCount?: number }
  | { type: "run-error"; id: string; outputs?: Cell["outputs"]; execCount?: number }
  | { type: "hydrate"; cells: Cell[] }
  | { type: "move"; id: string; dir: "up" | "down" };

function newCell(id: string, kind: CellKind, source: string): Cell {
  return { id, kind, source, status: "idle" };
}

/** The pure cell-list reducer (immutable). */
export function cellReducer(cells: readonly Cell[], action: NotebookAction): Cell[] {
  switch (action.type) {
    case "add": {
      const cell = newCell(action.id, action.kind ?? "code", action.source ?? "");
      if (!action.afterId) return [...cells, cell];
      const idx = cells.findIndex((c) => c.id === action.afterId);
      if (idx === -1) return [...cells, cell];
      return [...cells.slice(0, idx + 1), cell, ...cells.slice(idx + 1)];
    }
    case "remove":
      return cells.filter((c) => c.id !== action.id);
    case "update":
      return cells.map((c) => (c.id === action.id ? { ...c, source: action.source } : c));
    case "run-start":
      return cells.map((c) => (c.id === action.id ? { ...c, status: "running", outputs: [] } : c));
    case "append-output":
      // incremental streaming: append ONE kernel output to a cell's list (order-preserving).
      return cells.map((c) =>
        c.id === action.id ? { ...c, outputs: [...(c.outputs ?? []), action.output] } : c,
      );
    case "run-ok":
      return cells.map((c) =>
        c.id === action.id
          ? {
              ...c,
              status: "ok",
              ...(action.outputs ? { outputs: action.outputs } : {}),
              ...(action.execCount !== undefined ? { execCount: action.execCount } : {}),
            }
          : c,
      );
    case "run-error":
      return cells.map((c) =>
        c.id === action.id
          ? {
              ...c,
              status: "error",
              ...(action.outputs ? { outputs: action.outputs } : {}),
              ...(action.execCount !== undefined ? { execCount: action.execCount } : {}),
            }
          : c,
      );
    case "hydrate":
      // replace the whole cell list from a freshly-parsed .ipynb (open / reload).
      return [...action.cells];
    case "move": {
      const idx = cells.findIndex((c) => c.id === action.id);
      if (idx === -1) return [...cells];
      const swap = action.dir === "up" ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= cells.length) return [...cells];
      const next = [...cells];
      [next[idx], next[swap]] = [next[swap] as Cell, next[idx] as Cell];
      return next;
    }
  }
}

/** Execution summary for the notebook header. */
export function executionSummary(cells: readonly Cell[]): {
  running: number;
  ok: number;
  errors: number;
} {
  let running = 0;
  let ok = 0;
  let errors = 0;
  for (const c of cells) {
    if (c.status === "running") running += 1;
    else if (c.status === "ok") ok += 1;
    else if (c.status === "error") errors += 1;
  }
  return { running, ok, errors };
}

/** The next cell to focus after running (Shift+Enter advance), or undefined at the end. */
export function nextCellId(cells: readonly Cell[], current: string): string | undefined {
  const idx = cells.findIndex((c) => c.id === current);
  return idx >= 0 && idx < cells.length - 1 ? cells[idx + 1]?.id : undefined;
}
