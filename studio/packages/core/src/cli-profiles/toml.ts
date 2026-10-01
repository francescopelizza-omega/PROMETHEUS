// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * cli-profiles/toml.ts — a MINIMAL, dependency-free TOML subset parser (file 11 §6).
 *
 * Enough for the §6 profile schema only: `[section]` + nested `[a.b]` tables, and
 * `key = value` where value is a quoted string, true/false, a number, or an array of
 * those. NOT a full TOML implementation (no inline tables, no datetimes, no multi-line
 * strings) — profiles don't need them. Fail-soft: a malformed line is skipped, the
 * parser never throws (mirrors parseEngineObject's recovery philosophy).
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

/** Strip a `#` comment that is not inside a quoted string. */
function stripComment(line: string): string {
  let inStr = false;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === quote) inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw: string): TomlValue {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t; // bare string fallback
}

/** Split an array body on top-level commas (respecting quotes), then parse each. */
function parseArray(body: string): TomlValue[] {
  const items: string[] = [];
  let depth = 0;
  let inStr = false;
  let quote = "";
  let cur = "";
  for (const c of body) {
    if (inStr) {
      cur += c;
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      cur += c;
    } else if (c === "[") {
      depth++;
      cur += c;
    } else if (c === "]") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) items.push(cur);
  return items.map((s) => parseValue(s));
}

function parseValue(raw: string): TomlValue {
  const t = raw.trim();
  if (t.startsWith("[") && t.endsWith("]")) return parseArray(t.slice(1, -1));
  return parseScalar(t);
}

function isTable(v: TomlValue | undefined): v is TomlTable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Walk/create the nested table for a dotted section path. */
function ensurePath(root: TomlTable, path: string[]): TomlTable {
  let cur = root;
  for (const seg of path) {
    const key = seg.trim();
    const next = cur[key];
    if (isTable(next)) {
      cur = next;
    } else {
      const created: TomlTable = {};
      cur[key] = created;
      cur = created;
    }
  }
  return cur;
}

/* ------------------------------------------------------------------------- *
 * Serializer + dotted-path helpers (CLI-005) — the exact inverse of the subset
 * `parseToml` above. Emits ONLY what parseToml can re-read: `[a.b]` table
 * headers, bare keys, and string/number/bool/array scalars. Dots ALWAYS mean
 * nesting (a key that contains a `.` is unrepresentable — it would re-parse as a
 * table path). Comments are dropped and keys reordered (scalars before subtables).
 * ------------------------------------------------------------------------- */

/** Escape a basic-string value so `parseScalar` reads it back verbatim. */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\") // backslash FIRST (parseScalar unescapes \" then \\)
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n") // control chars kept on one line (parser is line-based)
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Emit one scalar/array value in a form `parseValue` round-trips. */
function emitValue(v: TomlValue): string {
  if (typeof v === "string") return `"${escapeString(v)}"`;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (Array.isArray(v)) return `[${v.map(emitValue).join(", ")}]`;
  return '""'; // a nested table is emitted as a header, never inline
}

function emitTable(table: TomlTable, path: string[], lines: string[]): void {
  const subTables: [string, TomlTable][] = [];
  // scalars/arrays FIRST — a subtable header would otherwise capture them.
  for (const [k, v] of Object.entries(table)) {
    if (isTable(v)) subTables.push([k, v]);
    else lines.push(`${k} = ${emitValue(v)}`);
  }
  for (const [k, v] of subTables) {
    const p = [...path, k];
    lines.push("");
    lines.push(`[${p.join(".")}]`);
    emitTable(v, p, lines);
  }
}

/** Serialize a nested table to the TOML subset `parseToml` accepts. */
export function stringifyToml(table: TomlTable): string {
  const lines: string[] = [];
  emitTable(table, [], lines);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Read a dotted key path (`a.b.c`) out of a table; undefined if any segment misses. */
export function getPath(table: TomlTable, path: string): TomlValue | undefined {
  let cur: TomlValue | undefined = table;
  for (const seg of path.split(".")) {
    if (!isTable(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Write a value at a dotted key path, creating intermediate tables as needed. */
export function setPath(table: TomlTable, path: string, value: TomlValue): void {
  const segs = path.split(".");
  const last = segs.pop() as string;
  let cur = table;
  for (const seg of segs) {
    const next = cur[seg];
    if (isTable(next)) {
      cur = next;
    } else {
      const created: TomlTable = {};
      cur[seg] = created;
      cur = created;
    }
  }
  cur[last] = value;
}

/** Parse a TOML subset document → a nested object. Fail-soft (never throws). */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let cur = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      cur = ensurePath(root, (section[1] as string).split("."));
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (kv) {
      cur[kv[1] as string] = parseValue(kv[2] as string);
    }
    // anything else is skipped (fail-soft)
  }
  return root;
}
