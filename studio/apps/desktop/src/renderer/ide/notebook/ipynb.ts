/**
 * ipynb.ts — pure nbformat-4 parse/serialize (APP-045), the reducer↔file seam.
 *
 * The notebook container hydrates cells from a `.ipynb` on open (`parseIpynb`) and writes
 * them back on Cmd-S (`serializeIpynb`). Round-trip preserves what Jupyter cares about:
 * top-level `nbformat`/`nbformat_minor`, `metadata` (kernelspec/language_info + any
 * unknown keys), and each cell's `id` (nbformat 4.5+) + unknown per-cell keys. Only a
 * cell's `source`/`cell_type` (and re-executed outputs) are rewritten; everything else
 * on the raw cell is carried through untouched so a save minimizes the git diff.
 *
 * nbformat quirk (do NOT get wrong): `cell.source` / `output.text` are EITHER a string OR
 * an array of line-strings where each element already carries its trailing `\n` — join
 * with "" and never re-insert `\n`, or every save doubles blank lines.
 */
import type { Cell, CellKind } from "./notebook-view.js";

/** A raw nbformat cell (opaque bag we preserve verbatim except source/type/outputs). */
export type RawCell = Record<string, unknown>;

/** The raw notebook object minus its cells — carried through for lossless round-trip. */
export interface RawNotebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: RawCell[];
  [k: string]: unknown;
}

export interface ParsedNotebook {
  cells: Cell[];
  /** the raw notebook (for metadata + per-cell extras) — hand back to serializeIpynb. */
  nb: RawNotebook;
}

/** nbformat multiline value → one string (elements already include their `\n`). */
function joinSource(v: unknown): string {
  if (Array.isArray(v)) return v.map((s) => (typeof s === "string" ? s : String(s))).join("");
  return typeof v === "string" ? v : "";
}

/** Split a string back into the nbformat line-array form (each line keeps its `\n`). */
function splitSource(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const out = parts.map((ln, i) => (i < parts.length - 1 ? `${ln}\n` : ln));
  // a trailing "\n" produces a final "" element Jupyter does not store — drop it.
  if (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Flatten one raw nbformat output into the reducer's {mime,data} view (best-effort). */
function flattenOutput(o: RawCell): { mime: string; data: string } | null {
  const type = o.output_type;
  if (type === "stream") {
    return { mime: "text/plain", data: joinSource(o.text) };
  }
  if (type === "error") {
    const tb = Array.isArray(o.traceback) ? (o.traceback as unknown[]).join("\n") : "";
    return { mime: "text/plain", data: tb || `${o.ename ?? "Error"}: ${o.evalue ?? ""}` };
  }
  if (type === "execute_result" || type === "display_data") {
    const data = (o.data ?? {}) as Record<string, unknown>;
    // richness order, but HTML is never rendered as markup (sandbox rule): png > plain.
    if (typeof data["image/png"] === "string")
      return { mime: "image/png", data: data["image/png"] as string };
    if (typeof data["image/jpeg"] === "string") {
      return { mime: "image/jpeg", data: data["image/jpeg"] as string };
    }
    if (data["text/plain"] !== undefined)
      return { mime: "text/plain", data: joinSource(data["text/plain"]) };
  }
  return null;
}

/** Reconstruct a raw nbformat output list from the reducer's flattened outputs. */
function reconstructOutputs(cell: Cell): RawCell[] {
  const out: RawCell[] = [];
  for (const o of cell.outputs ?? []) {
    if (o.mime.startsWith("image/")) {
      out.push({ output_type: "display_data", data: { [o.mime]: o.data }, metadata: {} });
    } else {
      out.push({ output_type: "stream", name: "stdout", text: splitSource(o.data) });
    }
  }
  return out;
}

/** Strip ANSI SGR escape codes (kernel tracebacks are ANSI-colored) → plain text. */
const ANSI_SGR = /\u001b\[[0-9;]*m/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, "");
}

let counter = 0;
/** A stable-ish fallback cell id when a raw cell has none (nbformat < 4.5). */
function mintId(index: number): string {
  counter += 1;
  return `cell-${index}-${counter}`;
}

/**
 * Parse `.ipynb` text → cells + the raw notebook. Never throws on a malformed file:
 * a parse failure yields an empty notebook shell (the caller shows it as an empty nb).
 */
export function parseIpynb(text: string): ParsedNotebook {
  let raw: RawNotebook;
  try {
    const parsed = JSON.parse(text) as Partial<RawNotebook>;
    raw = {
      nbformat: typeof parsed.nbformat === "number" ? parsed.nbformat : 4,
      nbformat_minor: typeof parsed.nbformat_minor === "number" ? parsed.nbformat_minor : 5,
      metadata: (parsed.metadata as Record<string, unknown>) ?? {},
      cells: Array.isArray(parsed.cells) ? (parsed.cells as RawCell[]) : [],
      ...Object.fromEntries(
        Object.entries(parsed).filter(
          ([k]) => !["nbformat", "nbformat_minor", "metadata", "cells"].includes(k),
        ),
      ),
    };
  } catch {
    raw = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] };
  }

  const cells: Cell[] = raw.cells.map((rc, i) => {
    const kind: CellKind = rc.cell_type === "markdown" ? "markdown" : "code";
    const id = typeof rc.id === "string" && rc.id ? rc.id : mintId(i);
    // stamp the id back onto the raw cell so serialize can match by id after moves.
    rc.id = id;
    const cell: Cell = { id, kind, source: joinSource(rc.source), status: "idle" };
    if (typeof rc.execution_count === "number") cell.execCount = rc.execution_count;
    const outputs = Array.isArray(rc.outputs)
      ? (rc.outputs as RawCell[])
          .map(flattenOutput)
          .filter((o): o is { mime: string; data: string } => o !== null)
      : [];
    if (outputs.length) cell.outputs = outputs;
    return cell;
  });

  return { cells, nb: raw };
}

/**
 * Serialize cells + the raw notebook back to `.ipynb` text. Preserves top-level +
 * per-cell unknown keys (matched by id); rewrites only source/cell_type, and outputs
 * only for cells run this session (idle-status cells keep their on-disk outputs).
 * JSON.stringify(nb, null, 1) + trailing newline matches Jupyter's on-disk convention.
 */
export function serializeIpynb(cells: readonly Cell[], nb: RawNotebook): string {
  const rawById = new Map<string, RawCell>();
  for (const rc of nb.cells) {
    if (typeof rc.id === "string") rawById.set(rc.id, rc);
  }
  const nextCells: RawCell[] = cells.map((c) => {
    // markdown cells carry no outputs/execution_count — omit those raw keys entirely.
    const {
      outputs: _rawOut,
      execution_count: _rawEc,
      ...carry
    } = rawById.get(c.id) ?? { metadata: {} };
    const base: RawCell = { ...carry, id: c.id, cell_type: c.kind, source: splitSource(c.source) };
    if (c.kind === "code") {
      // a cell run this session (ok/error/running) contributes fresh outputs; an
      // untouched (idle) cell keeps whatever raw outputs it had on disk.
      if (c.status !== "idle") {
        base.outputs = reconstructOutputs(c);
        base.execution_count = c.execCount ?? null;
      } else {
        base.outputs = Array.isArray(_rawOut) ? _rawOut : [];
        base.execution_count = _rawEc ?? c.execCount ?? null;
      }
    }
    return base;
  });
  const outNb: RawNotebook = { ...nb, cells: nextCells };
  return `${JSON.stringify(outNb, null, 1)}\n`;
}
