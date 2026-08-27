/**
 * render/envelope-view.ts — the LAST-RESORT projector for a plain engine envelope.
 *
 * The parity registry's `summarize()` produces `"<id>: ok"`, which is a correct SUMMARY
 * (a GUI toast) but was also being used as the CLI's TEXT SURFACE — so `superscan`,
 * `matrix`, `inventory`, `vault`, `where`, `describe`, `schedule` and friends printed one
 * word while their envelope carried the whole answer. This renders that envelope instead,
 * and the summary is kept only as the fallback for a genuinely empty payload.
 *
 * PURE presentation (C5): nothing here re-decides anything. Verdict-bearing envelopes are
 * handed to the verdict card first, `matrix` to the reach-grid projector; everything else
 * is shaped generically — scalars as a kv block, string arrays joined, object arrays as a
 * table — so a NEW engine surface renders usefully on day one with no per-verb glue.
 */
import type { EngineEnvelope, MatrixEnvelope } from "@prometheus/engine-bridge";

import { c, heading, kv, sym, table } from "../render.js";
import { verdictCardFromEnvelope } from "../verdict-view.js";
import { renderReachMatrix } from "./reach-matrix.js";

/** Envelope bookkeeping — never rendered as payload. */
const META_KEYS = new Set(["command", "ok", "error", "_exit", "schema", "forced_danger"]);

/** Widest table we will print; beyond this the payload belongs to `--json`. */
const MAX_COLUMNS = 6;
/** Rows shown before the "… and N more" footer. */
const MAX_ROWS = 40;
/**
 * Widest a single table cell may render before it is clipped.
 *
 * `table()` sizes each column to its widest cell, so one long field takes the whole row with it:
 * the catalog's `summary` runs to ~250 characters, which turned `plugin list` into a wall
 * wrapping several times per row on any real terminal. Clipping is a display decision only —
 * `--json` still carries the untouched value, and the clip marker says so at a glance.
 */
const MAX_CELL = 52;

type Scalar = string | number | boolean | null;

function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A scalar as a display cell: booleans become the ✓/· glyphs, null/"" become an em dash. */
/** Clip a plain (un-colored) cell to `MAX_CELL` visible characters. */
function clipCell(s: string): string {
  return s.length <= MAX_CELL ? s : `${s.slice(0, MAX_CELL - 1)}…`;
}

function cell(v: unknown): string {
  if (v === true) return sym.ok();
  if (v === false) return sym.off();
  if (v === null || v === undefined || v === "") return c.dim("—");
  if (Array.isArray(v)) {
    if (v.length === 0) return c.dim("—");
    const parts = v.filter(isScalar).map((x) => String(x));
    return parts.length > 0 ? clipCell(parts.join(", ")) : c.dim(`${v.length} item(s)`);
  }
  if (isPlainObject(v)) return c.dim("{…}");
  return clipCell(String(v));
}

/** Is this value renderable INSIDE a table cell (scalar, or an array of scalars)? */
function isCellable(v: unknown): boolean {
  return isScalar(v) || (Array.isArray(v) && v.every(isScalar));
}

/**
 * Column order for an array of records: the identifying key first (so a table reads
 * left-to-right the way a human scans it), then declaration order. Only keys that are
 * cell-renderable somewhere in the array become columns; a nested object stays in `--json`.
 */
const ID_KEYS = ["name", "id", "plugin", "agent", "label", "title"];

function columnsFor(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.includes(k) && isCellable(row[k])) seen.push(k);
    }
  }
  seen.sort((a, b) => {
    const ra = ID_KEYS.indexOf(a);
    const rb = ID_KEYS.indexOf(b);
    if (ra !== rb) return (ra < 0 ? ID_KEYS.length : ra) - (rb < 0 ? ID_KEYS.length : rb);
    return 0; // Array.prototype.sort is stable → declaration order is preserved
  });
  return seen.slice(0, MAX_COLUMNS);
}

/** Render an array of records as a table (with a truncation footer), or null if unrenderable. */
function renderRecordArray(label: string, rows: Record<string, unknown>[]): string[] | null {
  const cols = columnsFor(rows);
  if (cols.length === 0) return null;
  const shown = rows.slice(0, MAX_ROWS);
  const out = [
    c.bold(`${label} ${c.dim(`(${rows.length})`)}`),
    table(
      cols.map((h) => ({ header: h.replace(/_/g, " ").toUpperCase() })),
      shown.map((r) => cols.map((k) => cell(r[k]))),
    ),
  ];
  if (rows.length > shown.length) {
    out.push(c.dim(`  … and ${rows.length - shown.length} more (use --json)`));
  }
  return out;
}

/** Render one payload key. `depth` bounds the recursion into nested objects. */
function renderKey(key: string, value: unknown, depth: number): string[] {
  const label = key.replace(/_/g, " ");
  if (isScalar(value)) return [kv(label, cell(value))];

  if (Array.isArray(value)) {
    if (value.length === 0) return [kv(label, c.dim("none"))];
    if (value.every(isScalar)) return [kv(label, value.map((v) => String(v)).join(", "))];
    const records = value.filter(isPlainObject);
    if (records.length === value.length) {
      const rendered = renderRecordArray(label, records);
      if (rendered) return ["", ...rendered];
    }
    return [kv(label, c.dim(`${value.length} item(s) — use --json`))];
  }

  if (isPlainObject(value)) {
    if (depth <= 0) return [kv(label, c.dim("{…} — use --json"))];
    const inner = renderPayload(value, depth - 1);
    if (inner.length === 0) return [];
    return ["", c.bold(label), ...inner];
  }
  return [];
}

/** Render every non-meta key of an envelope/object. */
function renderPayload(obj: Record<string, unknown>, depth: number): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (META_KEYS.has(k)) continue;
    if (v === undefined) continue;
    out.push(...renderKey(k, v, depth));
  }
  // drop a leading blank (a payload that opens with a table shouldn't start on an empty line)
  while (out[0] === "") out.shift();
  return out;
}

/** Does this envelope look like the `matrix` reach grid? */
function isMatrix(env: EngineEnvelope): boolean {
  return (
    Array.isArray(env.agents) &&
    (env.agents as unknown[]).every((a) => typeof a === "string") &&
    Array.isArray(env.reach)
  );
}

/**
 * Render an engine envelope as human text. Returns null when the envelope carries no
 * payload worth printing — the caller then falls back to the one-line summary, so an
 * empty `{ok:true}` still says something and nothing is ever faked.
 *
 * An `ok:false` envelope still renders: the error line comes FIRST (it is the headline),
 * and any payload beneath it follows — `audit` reports ok:false while carrying a full
 * findings tree, and dropping that was hiding real security results.
 */
export function renderEnvelope(id: string, env: EngineEnvelope): string | null {
  // 1. a verdict-bearing envelope (nemesis / forced_danger / audit) owns the whole surface.
  const card = verdictCardFromEnvelope(env);
  if (card) return card;

  const head: string[] = [];
  if (env.ok === false) {
    head.push(
      c.red(`${id}: ${typeof env.error === "string" ? env.error : "engine returned ok:false"}`),
    );
  }

  // 2. the engine already formatted it (inventory/doctor-style `lines[]`) — print verbatim.
  if (Array.isArray(env.lines) && env.lines.every((l) => typeof l === "string")) {
    const lines = env.lines as string[];
    if (lines.length > 0) return [...head, ...lines].join("\n");
  }

  // 3. the reach grid has a bespoke projector — use it rather than a generic table.
  if (isMatrix(env)) {
    return [...head, renderReachMatrix(env as unknown as MatrixEnvelope)].join("\n");
  }

  // 4. generic shaping.
  const body = renderPayload(env, 2);
  if (body.length === 0) return head.length > 0 ? head.join("\n") : null;
  return [...head, heading(id), "", ...body].join("\n");
}
