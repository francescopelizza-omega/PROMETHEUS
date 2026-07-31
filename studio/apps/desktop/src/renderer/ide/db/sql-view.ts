/**
 * sql-view.ts — PURE SQL console display helpers (file 14 §3.26).
 *
 * The query runner is the sqlrunner.py sidecar over the env's DB driver (a runtime
 * seam; credentials in the 09 keychain, never plaintext). This owns the renderer's
 * display logic: results-grid paging, a SECRET-REDACTING connection-string parser, and
 * duration formatting — node:test-tested.
 */

export interface SqlResult {
  columns: string[];
  rows: (string | number | null)[][];
  rowCount: number;
  durationMs?: number;
}

export interface Page {
  rows: (string | number | null)[][];
  page: number;
  pageSize: number;
  total: number;
  maxPage: number;
}

/** Page a results grid without re-fetching (clamps the page into range). */
export function paginate(
  rows: readonly (string | number | null)[][],
  pageSize: number,
  page: number,
): Page {
  const size = Math.max(1, pageSize);
  const maxPage = Math.max(0, Math.ceil(rows.length / size) - 1);
  const p = Math.max(0, Math.min(page, maxPage));
  return {
    rows: rows.slice(p * size, p * size + size),
    page: p,
    pageSize: size,
    total: rows.length,
    maxPage,
  };
}

/** A parsed connection string — the PASSWORD is always redacted (never shown, §3.26/C5). */
export interface ParsedConn {
  driver?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** always "***" when a password was present (never the value). */
  password?: string;
}

/** Parse a `driver://user:pass@host:port/db` URL, redacting the password. */
export function parseConnString(conn: string): ParsedConn {
  const m =
    /^([a-z0-9+]+):\/\/(?:([^:@/]+)(?::([^@/]+))?@)?([^:/?]+)?(?::(\d+))?(?:\/([^?]+))?/i.exec(
      conn.trim(),
    );
  if (!m) return {};
  const out: ParsedConn = {};
  if (m[1]) out.driver = m[1].toLowerCase();
  if (m[2]) out.user = m[2];
  if (m[3]) out.password = "***"; // NEVER surface the real secret
  if (m[4]) out.host = m[4];
  if (m[5]) out.port = Number(m[5]);
  if (m[6]) out.database = m[6];
  return out;
}

/** Format a query duration for the result footer. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** A one-line result summary, e.g. "3 rows · 12.4ms". */
export function resultSummary(result: SqlResult): string {
  const dur = formatDuration(result.durationMs);
  return `${result.rowCount} row${result.rowCount === 1 ? "" : "s"}${dur ? ` · ${dur}` : ""}`;
}

/* ── result export (APP-087) — PURE, RFC-4180 CSV + JSON ─────────────────────── */

/** One CSV field, RFC-4180: quote if it contains a comma, quote, CR, or LF; inner `"`
 *  doubled. A null renders as an empty field. */
function csvField(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Export a result grid to RFC-4180 CSV (header row + data). CRLF line endings (the
 * spec's default); a field with an embedded comma/quote/newline is quoted, inner quotes
 * doubled. `bom` prepends a UTF-8 BOM for Excel compatibility (opt-in, off by default).
 */
export function toCsv(result: SqlResult, opts: { bom?: boolean } = {}): string {
  const header = result.columns.map(csvField).join(",");
  const body = result.rows.map((r) => r.map(csvField).join(",")).join("\r\n");
  const text = result.rows.length > 0 ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
  return opts.bom ? `﻿${text}` : text;
}

/** A schema table for the ER diagram (mirrors IdeSqlTable). */
export interface ErTable {
  name: string;
  columns: { name: string; dtype: string; pk: boolean; fk?: { table: string; to: string } }[];
}

/** mermaid-ER-safe identifier: alnum/underscore only (mirrors diagram.py `er`). */
function erSafe(name: string): string {
  return Array.from(name, (c) => (/[A-Za-z0-9_]/.test(c) ? c : "_")).join("") || "_";
}

/**
 * Render a schema as a mermaid `erDiagram` (APP-087) — PK/FK-marked attributes + FK edges.
 * Mirrors the canonical diagram.py `er` verb so the tool window can show it inline (C5:
 * no sidecar-stdin seam here). An FK to a table NOT in the set draws no edge (no dangling).
 */
export function tablesToErMermaid(tables: readonly ErTable[]): string {
  const names = new Set(tables.map((t) => t.name));
  const lines = ["erDiagram"];
  const edges: string[] = [];
  for (const t of tables) {
    const ent = erSafe(t.name);
    lines.push(`  ${ent} {`);
    for (const c of t.columns ?? []) {
      const marks = `${c.pk ? " PK" : ""}${c.fk ? " FK" : ""}`;
      if (c.fk && names.has(c.fk.table)) {
        edges.push(`  ${erSafe(c.fk.table)} ||--o{ ${ent} : "${c.name}"`);
      }
      lines.push(`    ${erSafe(c.dtype || "text")} ${erSafe(c.name)}${marks}`);
    }
    lines.push("  }");
  }
  return [...lines, ...edges].join("\n");
}

/** Export a result grid to a JSON array of row objects (column-name keyed). */
export function toJson(result: SqlResult): string {
  const rows = result.rows.map((r) => {
    const obj: Record<string, string | number | null> = {};
    result.columns.forEach((c, i) => {
      obj[c] = r[i] ?? null;
    });
    return obj;
  });
  return `${JSON.stringify(rows, null, 2)}\n`;
}
