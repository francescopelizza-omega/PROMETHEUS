// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * format/editorconfig.ts — a PURE, dependency-free `.editorconfig` resolver
 * (APP-019 · MDS parity file 29). Parses the INI-ish format, matches its section
 * globs against a path, honors `root=true` (stop the parent walk), and merges
 * nearest-file-wins / last-section-wins into resolved editor properties.
 *
 * NO npm `editorconfig` dep (directive): the glob subset — `*` (not `/`), `**`
 * (across `/`), `?`, `[abc]`/`[!abc]`, `{a,b}`, `{1..3}` — is translated to RegExp
 * by hand. NO fs: the caller (path-guarded fs IPC, stopping at the workspace root)
 * supplies each `.editorconfig`'s text; this module only computes. Node built-ins
 * only (none needed — pure string math).
 */

/** One `[glob]` section: its pattern + the raw key→value props under it. */
export interface EditorConfigSection {
  pattern: string;
  props: Record<string, string>;
}

/** A parsed `.editorconfig` file: the `root` flag + its ordered sections. */
export interface ParsedEditorConfig {
  root: boolean;
  sections: EditorConfigSection[];
}

/** The resolved editor properties for a path (only the keys actually set appear). */
export interface ResolvedEditorConfig {
  indentStyle?: "tab" | "space";
  indentSize?: number;
  tabWidth?: number;
  endOfLine?: "lf" | "crlf" | "cr";
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  charset?: string;
}

/* ------------------------------------------------------------------------- *
 * Parsing
 * ------------------------------------------------------------------------- */

/**
 * Parse `.editorconfig` text: the pre-section `root=true` preamble + each `[glob]`
 * section's `key = value` props (keys lowercased, values trimmed). Comments (`#`/`;`)
 * and blank lines are ignored. Malformed lines are skipped, never fatal.
 */
export function parseEditorConfig(text: string): ParsedEditorConfig {
  let root = false;
  const sections: EditorConfigSection[] = [];
  let current: EditorConfigSection | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      // the section pattern is between the first "[" and the LAST "]" on the line
      // (a `[` may appear inside a `[abc]` char class within the glob).
      const close = line.lastIndexOf("]");
      if (close <= 0) continue;
      current = { pattern: line.slice(1, close), props: {} };
      sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    if (current) current.props[key] = value;
    else if (key === "root") root = value.toLowerCase() === "true";
  }
  return { root, sections };
}

/* ------------------------------------------------------------------------- *
 * Glob matching (the editorconfig-core subset — NOT plain fnmatch)
 * ------------------------------------------------------------------------- */

/** Escape a literal char for use inside a RegExp. */
function escapeRe(ch: string): string {
  return /[.+^$()|\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Hard cap on `{n..m}` enumeration. A `.editorconfig` comes from an UNTRUSTED (cloned)
 *  workspace; enumerating `{0..500000000}` into a regex alternation would freeze or OOM
 *  the renderer on save/open. Real ranges are tiny — beyond this, fall back to a bounded
 *  "any integer" match (`-?\d+`) instead of materializing the list. */
const NUMERIC_RANGE_CAP = 4096;

/** Expand a numeric `{n..m}` range into its integer list (ascending or descending), or
 *  null when the span exceeds NUMERIC_RANGE_CAP (the caller emits a safe bounded regex). */
function numericRange(a: number, b: number): number[] | null {
  if (Math.abs(b - a) + 1 > NUMERIC_RANGE_CAP) return null;
  const out: number[] = [];
  if (a <= b) for (let i = a; i <= b; i++) out.push(i);
  else for (let i = a; i >= b; i--) out.push(i);
  return out;
}

/**
 * Translate one editorconfig glob (already stripped of a leading slash and, for the
 * any-depth case, prefixed with a double-star + slash) into an anchored RegExp source
 * string. Handles double-star, single-star, `?`, `[..]`/`[!..]`, `{a,b}`, `{n..m}`.
 */
function globToRegexSource(pattern: string): string {
  let out = "";
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` → zero-or-more path segments; a bare `**` → anything incl. `/`.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (ch === "[") {
      // a char class: `[abc]` / `[!abc]` (ONLY `!` negates in editorconfig). Copy the body
      // through to the closing `]`.
      let j = i + 1;
      let neg = false;
      if (pattern[j] === "!") {
        neg = true;
        j++;
      }
      let body = "";
      while (j < n && pattern[j] !== "]") {
        body += pattern[j];
        j++;
      }
      if (j >= n) {
        // no closing `]` — treat the `[` literally.
        out += "\\[";
        i += 1;
      } else {
        // a leading literal `^` is an ordinary set member in editorconfig (only `!`
        // negates) — escape it so JS doesn't read `[^…]` as a negated class.
        const safeBody = neg ? body : body.replace(/^\^/, "\\^");
        out += `[${neg ? "^" : ""}${safeBody}]`;
        i = j + 1;
      }
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
        i += 1;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(inner);
      if (range) {
        const nums = numericRange(Number(range[1]), Number(range[2]));
        // a bounded range → an exact alternation; an over-large range → a safe
        // "any integer" match (never enumerate untrusted N — DoS guard).
        out += nums ? `(?:${nums.map((x) => `${x}`).join("|")})` : "-?\\d+";
      } else if (inner.includes(",")) {
        // comma alternation — each alternative is itself a (nested-free) glob.
        const alts = inner.split(",").map((a) => globToRegexSource(a));
        out += `(?:${alts.join("|")})`;
      } else {
        // a comma-less, non-range group matches LITERALLY per the editorconfig spec
        // (`{single}` matches the file named `{single}`; `{}` matches `{}`).
        out += `\\{${globToRegexSource(inner)}\\}`;
      }
      i = close + 1;
    } else if (ch === "/") {
      out += "/";
      i += 1;
    } else {
      out += escapeRe(ch);
      i += 1;
    }
  }
  return out;
}

/**
 * Does an editorconfig section `pattern` match `relPath` (the target path RELATIVE
 * to the config file's directory, `/`-separated)? A pattern with no `/` matches the
 * basename at any depth; a leading `/` or an embedded `/` anchors it to the config
 * dir. Returns false on a bad pattern rather than throwing.
 */
export function editorConfigMatches(pattern: string, relPath: string): boolean {
  let pat = pattern;
  if (pat.startsWith("/")) pat = pat.slice(1);
  else if (!pat.includes("/")) pat = `**/${pat}`;
  try {
    return new RegExp(`^${globToRegexSource(pat)}$`).test(relPath);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- *
 * Resolution — nearest-file-wins, last-section-wins, root=true stop
 * ------------------------------------------------------------------------- */

/** A parsed `.editorconfig` tied to the absolute directory it lives in. */
export interface EditorConfigEntry {
  /** the directory holding this `.editorconfig` (no trailing slash). */
  dir: string;
  parsed: ParsedEditorConfig;
}

/** Normalize a raw prop value: lowercased; "unset" stays literal for the skip check. */
function lc(v: string | undefined): string | undefined {
  return v === undefined ? undefined : v.trim().toLowerCase();
}

/**
 * Resolve the effective editor properties for `absPath` from a chain of
 * `.editorconfig` entries ordered NEAREST→FARTHEST (the file's own dir first, then
 * ancestors). The walk stops at (and includes) the first entry with `root=true` —
 * farther entries are ignored. Within a file, later matching sections override
 * earlier ones; across files, the nearer file wins. `unset` clears a key back to
 * "editor default" (the key is simply omitted from the result). Pure.
 */
export function resolveEditorConfig(
  chain: readonly EditorConfigEntry[],
  absPath: string,
): ResolvedEditorConfig {
  // trim the chain at the first root=true (nearest→farthest order).
  const rootIdx = chain.findIndex((e) => e.parsed.root);
  const scoped = rootIdx === -1 ? chain : chain.slice(0, rootIdx + 1);

  // accumulate raw props FARTHEST→NEAREST so the nearest file's props win.
  const raw: Record<string, string> = {};
  for (let i = scoped.length - 1; i >= 0; i--) {
    const entry = scoped[i];
    if (!entry) continue;
    if (!absPath.startsWith(`${entry.dir}/`) && absPath !== entry.dir) continue;
    const rel = absPath.startsWith(`${entry.dir}/`) ? absPath.slice(entry.dir.length + 1) : absPath;
    for (const section of entry.parsed.sections) {
      if (editorConfigMatches(section.pattern, rel)) {
        for (const [k, v] of Object.entries(section.props)) raw[k] = v;
      }
    }
  }

  const out: ResolvedEditorConfig = {};
  const indentStyle = lc(raw.indent_style);
  if (indentStyle === "tab" || indentStyle === "space") out.indentStyle = indentStyle;

  const tabWidth = raw.tab_width !== undefined ? Number.parseInt(raw.tab_width, 10) : undefined;
  if (tabWidth !== undefined && Number.isFinite(tabWidth) && tabWidth > 0) out.tabWidth = tabWidth;

  const rawIndentSize = lc(raw.indent_size);
  if (rawIndentSize !== undefined && rawIndentSize !== "unset") {
    if (rawIndentSize === "tab") {
      // indent_size=tab mirrors tab_width (default 8 per spec when tab_width unset).
      out.indentSize = out.tabWidth ?? 8;
    } else {
      const size = Number.parseInt(rawIndentSize, 10);
      if (Number.isFinite(size) && size > 0) out.indentSize = size;
    }
  }
  // a tab-indented file with no explicit indent_size mirrors tab_width for the editor.
  if (out.indentStyle === "tab" && out.indentSize === undefined && out.tabWidth !== undefined) {
    out.indentSize = out.tabWidth;
  }

  const eol = lc(raw.end_of_line);
  if (eol === "lf" || eol === "crlf" || eol === "cr") out.endOfLine = eol;

  const trim = lc(raw.trim_trailing_whitespace);
  if (trim === "true") out.trimTrailingWhitespace = true;
  else if (trim === "false") out.trimTrailingWhitespace = false;

  const finalNl = lc(raw.insert_final_newline);
  if (finalNl === "true") out.insertFinalNewline = true;
  else if (finalNl === "false") out.insertFinalNewline = false;

  const charset = lc(raw.charset);
  if (charset && charset !== "unset") out.charset = charset;

  return out;
}

/* ------------------------------------------------------------------------- *
 * Save-time text transforms (editorconfig-driven, run before fsWrite)
 * ------------------------------------------------------------------------- */

/** The trailing-whitespace / final-newline / EOL transforms editorconfig implies but
 *  Monaco won't do on its own. Applied as a string pass in the save path (APP-019 d3). */
export function applyEditorConfigTextRules(text: string, cfg: ResolvedEditorConfig): string {
  let out = text;
  if (cfg.trimTrailingWhitespace) {
    out = out
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n");
  }
  if (cfg.insertFinalNewline === true) {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
  } else if (cfg.insertFinalNewline === false) {
    out = out.replace(/\n+$/, "");
  }
  if (cfg.endOfLine === "crlf") out = out.replace(/\r?\n/g, "\r\n");
  else if (cfg.endOfLine === "lf") out = out.replace(/\r\n/g, "\n");
  else if (cfg.endOfLine === "cr") out = out.replace(/\r?\n/g, "\r");
  return out;
}
