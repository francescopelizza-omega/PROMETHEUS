/**
 * editor/smart-keys.ts — PURE smart-key logic + the clipboard-stack reducer
 * (MDS parity file 01: complete-statement ⇧⌘⏎, smart-enter, paste-history ring).
 *
 * Framework-free by contract (file 07 §8 / this package's GOLDEN RULE): every
 * function here RETURNS plain data — `{ range, text }` edits with 1-based
 * line/col positions — and the host (EditorPane via Monaco `executeEdits`,
 * `prom` via its buffer math) translates to its own types. NO monaco/react/
 * electron imports, ever: leaking a `monaco.Selection` here breaks the core
 * build for the CLI.
 *
 * SCOPE (deliberate): completeStatement/smartEnterEdit are SINGLE-LINE heuristics
 * (JetBrains "Complete Statement" is parser-backed; we are not). They do not see
 * comments, multi-line/template/triple-quoted strings, or a `\r`-terminated line
 * (Monaco's getLineContent strips the EOL, so the host never passes one). The
 * worst case is a slightly-off completion the user undoes — the edit is always
 * confined to the caret's line plus the lines it inserts, never other content.
 * `clipPush`/`clipCycle` are the host-agnostic ring reducer for `prom` parity; the
 * renderer's own clipboard-store keeps its `pushClip` (same math, its own tests).
 *
 * Node built-ins only (none needed — pure string math).
 */

/* ------------------------------------------------------------------------- *
 * Plain shapes (host-translatable; 1-based like Monaco/LSP-rendered positions)
 * ------------------------------------------------------------------------- */

/** A 1-based caret position. */
export interface SmartPosition {
  line: number;
  col: number;
}

/** A plain text edit over a 1-based range (host converts to monaco.Range). */
export interface SmartEdit {
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  text: string;
}

/** A smart-key result: ONE edit + where the caret lands after it applies. */
export interface SmartKeyResult {
  edit: SmartEdit;
  caret: SmartPosition;
}

/* ------------------------------------------------------------------------- *
 * Language classification (python vs the C-like default)
 * ------------------------------------------------------------------------- */

function isPython(lang: string): boolean {
  return lang === "python";
}

/** Python HARD block-header keywords (reserved — never valid identifiers) that take a
 *  trailing `:`. `if x = 1` etc. are syntax errors, so no assignment false-positives. */
const PY_HARD_HEADERS = /^(if|elif|else|for|while|def|class|with|try|except|finally|async)\b/;

/** Python SOFT block keywords (`match`/`case` are ALSO ordinary identifiers). A line is
 *  a real header only as `match SUBJECT` — a space then a non-`=` token — so the far more
 *  common `match = re.match(x)` / `case = 5` assignments are NOT mis-colon'd. */
const PY_SOFT_HEADER = /^(match|case)\s+[^=\s]/;

/** Is `trimmed` a python block header (hard keyword, or a real soft-keyword header)? */
function isPyHeader(trimmed: string): boolean {
  return PY_HARD_HEADERS.test(trimmed) || PY_SOFT_HEADER.test(trimmed);
}

/** C-like control keywords whose completion opens a `{ … }` block. */
const C_HEADERS = /^(if|else|for|while|switch|do|try|catch|finally|function)\b/;

/* ------------------------------------------------------------------------- *
 * Line scanning — unclosed quotes + bracket stack (escape-aware)
 * ------------------------------------------------------------------------- */

interface LineScan {
  /** the still-open quote char at end-of-line, or null. */
  openQuote: string | null;
  /** unclosed openers in order of opening (subset of `([{`). */
  openers: string[];
}

const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

function scanLine(line: string): LineScan {
  const openers: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === "\\")
        i++; // skip the escaped char
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") openers.push(ch);
    else if (ch === ")" || ch === "]" || ch === "}") {
      const last = openers[openers.length - 1];
      if (last && CLOSER[last] === ch) openers.pop();
    }
  }
  return { openQuote: quote, openers };
}

/** The line's leading whitespace (kept verbatim — tabs stay tabs). */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/* ------------------------------------------------------------------------- *
 * completeStatement — JetBrains ⇧⌘⏎ "Complete Current Statement"
 * ------------------------------------------------------------------------- */

/**
 * Complete `line` (the FULL text of line `lineNumber`) into a syntactically
 * closed statement for `lang`, returning ONE whole-line replacement edit plus
 * the resulting caret:
 *
 * - unclosed quotes close first, then unbalanced `(`/`[` (innermost-first);
 * - python: block headers (`if x` → `if x:`) gain their `:` and the caret lands
 *   on a new, one-level-deeper line; plain statements just get a new line;
 * - C-like: control headers gain a ` { … }` block with the caret inside
 *   (`if (x` → `if (x) {\n\t\n}`); plain statements gain a terminating `;`;
 * - a line that is already complete degrades to smart-enter (new indented line),
 *   so the chord is always safe to press.
 */
export function completeStatement(line: string, lineNumber: number, lang: string): SmartKeyResult {
  const indent = indentOf(line);
  const scan = scanLine(line);
  const trimmed = line.trim();

  // close the open quote, then every unclosed ( / [ — the { (C-like) becomes a block.
  let closed = line;
  if (scan.openQuote) closed += scan.openQuote;
  const pendingBrace = !isPython(lang) && scan.openers.includes("{");
  for (const opener of [...scan.openers].reverse()) {
    if (!isPython(lang) && opener === "{") continue; // handled as a block below
    closed += CLOSER[opener];
  }

  let text: string;
  let caret: SmartPosition;
  if (isPython(lang)) {
    const isHeader = isPyHeader(trimmed);
    const needsColon = isHeader && !closed.trimEnd().endsWith(":");
    const body = needsColon ? `${closed.trimEnd()}:` : closed;
    const nextIndent = isHeader ? `${indent}\t` : indent;
    text = `${body}\n${nextIndent}`;
    caret = { line: lineNumber + 1, col: nextIndent.length + 1 };
  } else if (pendingBrace || (C_HEADERS.test(trimmed) && !closed.includes("{"))) {
    // open (or complete) the block: caret on the empty, one-deeper middle line.
    const head = pendingBrace ? closed : `${closed.trimEnd()} {`;
    text = `${head}\n${indent}\t\n${indent}}`;
    caret = { line: lineNumber + 1, col: indent.length + 2 };
  } else {
    const t = closed.trimEnd();
    const terminated = t === "" || /[;{}:,]$/.test(t) ? closed : `${t};`;
    text = `${terminated}\n${indent}`;
    caret = { line: lineNumber + 1, col: indent.length + 1 };
  }

  return {
    edit: {
      range: { startLine: lineNumber, startCol: 1, endLine: lineNumber, endCol: line.length + 1 },
      text,
    },
    caret,
  };
}

/* ------------------------------------------------------------------------- *
 * smartEnterEdit — indentation-aware Enter (block-open deepens; brace splits)
 * ------------------------------------------------------------------------- */

/** The context smartEnterEdit needs: the caret's line text + 1-based position. */
export interface SmartEnterContext {
  line: string;
  lineNumber: number;
  /** 1-based caret column within `line`. */
  col: number;
  lang: string;
}

/**
 * An Enter press that keeps the current indentation and deepens it by one after
 * a block opener (`{`/`(`/`[`, or a python `:`). When the caret sits between
 * `{` and `}` the brace SPLITS: two lines are inserted and the caret lands on
 * the deeper middle line. Returns one caret-anchored insertion edit. Pure.
 */
export function smartEnterEdit(ctx: SmartEnterContext): SmartKeyResult {
  const indent = indentOf(ctx.line);
  const before = ctx.line.slice(0, ctx.col - 1).trimEnd();
  const after = ctx.line.slice(ctx.col - 1).trimStart();
  const opensBlock = isPython(ctx.lang) ? /:$/.test(before) : /[{([]$/.test(before);
  const deeper = `${indent}\t`;

  const at = {
    startLine: ctx.lineNumber,
    startCol: ctx.col,
    endLine: ctx.lineNumber,
    endCol: ctx.col,
  };
  if (!isPython(ctx.lang) && /\{$/.test(before) && /^\}/.test(after)) {
    // caret between { and } — split into a deeper middle line + the closer's line.
    return {
      edit: { range: at, text: `\n${deeper}\n${indent}` },
      caret: { line: ctx.lineNumber + 1, col: deeper.length + 1 },
    };
  }
  const nextIndent = opensBlock ? deeper : indent;
  return {
    edit: { range: at, text: `\n${nextIndent}` },
    caret: { line: ctx.lineNumber + 1, col: nextIndent.length + 1 },
  };
}

/* ------------------------------------------------------------------------- *
 * Clipboard-stack reducer (push / cycle / cap) — the ⌘⇧V ring, host-agnostic
 * ------------------------------------------------------------------------- */

/** The default ring capacity (mirrors the renderer store's CLIP_CAP). */
export const CLIP_RING_CAP = 30;

/**
 * Push `text` onto the ring: an identical existing entry floats to the top
 * (no duplicates), whitespace-only text is ignored, the ring caps at `cap`
 * (oldest evicted). Immutable.
 */
export function clipPush(entries: readonly string[], text: string, cap = CLIP_RING_CAP): string[] {
  if (!text.trim()) return [...entries];
  const deduped = entries.filter((e) => e !== text);
  return [text, ...deduped].slice(0, Math.max(1, cap));
}

/**
 * Cycle the ring one step: the head moves to the back, so repeated paste-cycle
 * walks every entry and wraps around. Immutable; a 0/1-entry ring is unchanged.
 */
export function clipCycle(entries: readonly string[]): string[] {
  if (entries.length < 2) return [...entries];
  const [head, ...rest] = entries as [string, ...string[]];
  return [...rest, head];
}
