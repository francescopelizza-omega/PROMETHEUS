// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/quick-doc.ts — PURE documentation helpers for Quick Doc (⌘J), the docstring-stub
 * generator, and reader-mode (APP-098). React-free/DOM-free so it unit-tests under node:test.
 *
 * Hover markdown is REMOTE-INFLUENCED (LSP servers echo source + docs), so this module only
 * STRUCTURES the content — it never renders HTML. The view renders `markdown` through the
 * existing sanitizing <Markdown> path (React-escaped, never dangerouslySetInnerHTML) and opens
 * a link ONLY on an explicit click, and ONLY for an allowlisted host (the URL-injection L5/L6
 * posture applied to docs). `lspContentsToMarkdown` is EXTRACTED verbatim from EditorPane (one
 * hover flattener, not two) and re-imported there.
 */

import type { NormalizedSymbol } from "./lsp-convert.js";

/** LSP SymbolKind values that are callable (Method / Constructor / Function). */
const CALLABLE_KINDS = new Set([6, 9, 12]);

/** Structured Quick Doc: the leading code signature, the prose markdown, and any doc links. */
export interface QuickDoc {
  signature: string;
  markdown: string;
  links: DocLink[];
}

/** An extracted documentation URL + whether its host is on the open-in-browser allowlist. */
export interface DocLink {
  url: string;
  host: string;
  /** true ⇒ render an "open" affordance (routes through the main openExternal scheme gate);
   *  false ⇒ render inert with a copy affordance only (never spawns a browser). */
  allowed: boolean;
}

/** Hosts whose docs may open in the OS browser on one click. A URL to any other host renders
 *  as inert copy-only text — defense-in-depth over the main scheme gate (URL-injection L6). */
const ALLOWED_DOC_HOSTS: readonly string[] = [
  "docs.python.org",
  "developer.mozilla.org",
  "pkg.go.dev",
  "doc.rust-lang.org",
  "docs.rs",
  "github.com",
  "gitlab.com",
  "typescriptlang.org",
  "nodejs.org",
  "readthedocs.io",
];

/**
 * Flatten an LSP hover `contents` (string | MarkedString | MarkupContent | array) into
 * Markdown strings. EXTRACTED verbatim from EditorPane so there is exactly one hover flattener.
 */
export function lspContentsToMarkdown(contents: unknown): string[] {
  const one = (c: unknown): string => {
    if (typeof c === "string") return c;
    if (c && typeof c === "object") {
      const o = c as { value?: unknown; language?: unknown };
      if (typeof o.value === "string") {
        return typeof o.language === "string" ? `\`\`\`${o.language}\n${o.value}\n\`\`\`` : o.value;
      }
    }
    return "";
  };
  const arr = Array.isArray(contents) ? contents : [contents];
  return arr.map(one).filter((s) => s.length > 0);
}

/** Classify a bare URL: allowlisted host ⇒ openable, else inert copy-only. */
export function classifyLink(url: string): DocLink {
  let host = "";
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return { url, host: "", allowed: false };
  }
  const allowed = ALLOWED_DOC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return { url, host, allowed };
}

/** Extract bare `https://` URLs from text (deduped, trailing punctuation trimmed). */
function extractHttpsLinks(text: string): DocLink[] {
  const out: DocLink[] = [];
  const seen = new Set<string>();
  const re = /https:\/\/[^\s<>()[\]"'`]+/g;
  for (const m of text.matchAll(re)) {
    const url = m[0].replace(/[.,;:]+$/, ""); // drop sentence punctuation glued to the URL
    if (!seen.has(url)) {
      seen.add(url);
      out.push(classifyLink(url));
    }
  }
  return out;
}

/**
 * Structure an LSP hover result into a Quick Doc: the first fenced code block becomes the
 * `signature`, the remaining blocks join into `markdown`, and every bare https URL is
 * extracted + classified. Returns null when there is no usable content.
 */
export function hoverToDoc(contents: unknown): QuickDoc | null {
  const blocks = lspContentsToMarkdown(contents);
  if (blocks.length === 0) return null;
  let signature = "";
  const prose: string[] = [];
  for (const b of blocks) {
    const fence = b.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    if (fence && !signature) {
      signature = fence[1]?.trim() ?? "";
    } else {
      prose.push(b);
    }
  }
  const markdown = prose.join("\n\n").trim();
  const links = extractHttpsLinks(blocks.join("\n"));
  return { signature, markdown, links };
}

/** A parameter for the docstring stub (name only — types come from the signature). */
export interface StubParam {
  name: string;
}

/**
 * Extract parameter NAMES from a function signature string (documentSymbol `detail` or the def
 * line). Reads the first parenthesized group, splits top-level commas, and takes the leading
 * identifier of each part (dropping types/defaults). Python `self`/`cls` are skipped.
 */
export function parseParamNames(signature: string, languageId: string): StubParam[] {
  const open = signature.indexOf("(");
  if (open < 0) return [];
  // find the matching close paren (depth-aware over nested [] {} () in type annotations).
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const c = signature[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const inner = signature.slice(open + 1, close < 0 ? undefined : close);
  if (!inner.trim()) return [];
  const skip = languageId.toLowerCase() === "python" ? new Set(["self", "cls"]) : new Set<string>();
  const out: StubParam[] = [];
  // split on top-level commas only.
  const parts: string[] = [];
  let d = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") d++;
    // only close-brackets and a `>` that has a matching open `<` decrement depth — a stray `>`
    // from an arrow type (`() => void`) must NOT drive `d` negative, else the following
    // top-level comma is seen at d=-1 and never splits, dropping every later param.
    else if (ch === ")" || ch === "]" || ch === "}") d--;
    else if (ch === ">" && d > 0) d--;
    if (ch === "," && d === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    // leading identifier: strip destructuring/rest/markers, take [A-Za-z_$][\w$]*
    const m = p.trim().match(/^[*&]*\.{0,3}\s*([A-Za-z_$][\w$]*)/);
    const name = m?.[1];
    if (name && !skip.has(name)) out.push({ name });
  }
  return out;
}

/**
 * Build the idiomatic docstring stub for the enclosing function. Python emits a triple-quoted
 * block (Args:/Returns:) that goes INSIDE the body; TS/JS emit a JSDoc `/** *​/` block that
 * goes BEFORE the function. The returned text is UN-indented (the caller prefixes each line
 * with the detected indent). An unknown language ⇒ null.
 */
export function buildDocstringStub(opts: {
  languageId: string;
  name: string;
  params: StubParam[];
  returns?: boolean;
}): string | null {
  const { languageId, name, params, returns } = opts;
  const lang = languageId.toLowerCase();
  if (lang === "python") {
    // a bare function gets the idiomatic one-line docstring; Args:/Returns: only when there's
    // something to document.
    if (params.length === 0 && !returns) return '"""Summary."""';
    const lines = ['"""Summary.', ""];
    if (params.length > 0) {
      lines.push("Args:");
      for (const p of params) lines.push(`    ${p.name}: `);
      lines.push("");
    }
    if (returns) {
      lines.push("Returns:", "    ", "");
    }
    // trim a trailing blank before the closing fence
    while (lines[lines.length - 1] === "") lines.pop();
    lines.push('"""');
    return lines.join("\n");
  }
  if (
    lang === "typescript" ||
    lang === "javascript" ||
    lang === "typescriptreact" ||
    lang === "javascriptreact"
  ) {
    const lines = ["/**", " * Summary."];
    for (const p of params) lines.push(` * @param ${p.name}`);
    if (returns) lines.push(" * @returns");
    lines.push(" */");
    // `name` is unused in the JSDoc body but kept in the signature for parity/future use.
    void name;
    return lines.join("\n");
  }
  return null;
}

/**
 * The DEEPEST callable (method/function/constructor) whose range contains the 0-based
 * (line, character) — the target for the docstring stub. Returns null when the caret is not
 * inside a function.
 */
export function enclosingFunction(
  symbols: readonly NormalizedSymbol[],
  line: number,
  character: number,
): NormalizedSymbol | null {
  const contains = (r: NormalizedSymbol["range"]): boolean => {
    if (line < r.start.line || line > r.end.line) return false;
    if (line === r.start.line && character < r.start.character) return false;
    if (line === r.end.line && character > r.end.character) return false;
    return true;
  };
  let found: NormalizedSymbol | null = null;
  const walk = (list: readonly NormalizedSymbol[]): void => {
    for (const s of list) {
      if (contains(s.range)) {
        if (typeof s.kind === "number" && CALLABLE_KINDS.has(s.kind)) found = s;
        walk(s.children);
      }
    }
  };
  walk(symbols);
  return found;
}

/** A 0-based inclusive line range (for reader-mode decorations). */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * Detect DOC-comment blocks in a file's lines (view-only reader mode decorates these; the model
 * text is never touched). TS/JS: `/** … *​/` JSDoc blocks. Python: `"""…"""` / `'''…'''`
 * docstrings. Returns 0-based inclusive ranges in source order.
 */
export function docCommentRanges(lines: readonly string[], languageId: string): LineRange[] {
  const lang = languageId.toLowerCase();
  const out: LineRange[] = [];
  if (lang === "python") {
    let open: number | null = null;
    let quote = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (open === null) {
        const m = line.match(/("""|''')/);
        if (m) {
          quote = m[1] as string;
          const after = line.slice((m.index ?? 0) + 3);
          if (after.includes(quote)) {
            out.push({ startLine: i, endLine: i }); // single-line docstring
          } else {
            open = i;
          }
        }
      } else if (line.includes(quote)) {
        out.push({ startLine: open, endLine: i });
        open = null;
      }
    }
    return out;
  }
  if (
    lang === "typescript" ||
    lang === "javascript" ||
    lang === "typescriptreact" ||
    lang === "javascriptreact"
  ) {
    let open: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (open === null) {
        if (line.includes("/**")) {
          if (line.includes("*/", line.indexOf("/**") + 3)) {
            out.push({ startLine: i, endLine: i }); // single-line /** … */
          } else {
            open = i;
          }
        }
      } else if (line.includes("*/")) {
        out.push({ startLine: open, endLine: i });
        open = null;
      }
    }
    return out;
  }
  return out;
}
