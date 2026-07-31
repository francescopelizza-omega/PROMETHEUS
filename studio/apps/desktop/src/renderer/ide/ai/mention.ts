/**
 * ai/mention.ts — the PURE @-mention model for the AgentPane (APP-054).
 *
 * Beyond files, the composer supports `@sym:`/`@folder:`/`@docs:` mentions (+ the bare
 * `@relpath` file mention, kept intact). This owns the caret-anchored active-mention
 * detection, kind classification, the attach-builders' pure math (symbol slice, folder/
 * docs cap + discovery), and the chip reducer — all node:test-ed, no react/DOM.
 */

export type MentionKind = "file" | "sym" | "folder" | "docs";

export interface ParsedMention {
  kind: MentionKind;
  /** the text after the (optional) `kind:` prefix — what the picker fuzzy-matches. */
  query: string;
  /** the full token WITHOUT the leading `@` (e.g. "sym:Widget" or "src/a.ts"). */
  token: string;
}

const PREFIXES: Record<string, MentionKind> = {
  "sym:": "sym",
  "folder:": "folder",
  "dir:": "folder",
  "docs:": "docs",
  "doc:": "docs",
};

/**
 * Classify a mention token (the text after `@`). Prefixed kinds win; anything else is a
 * bare FILE mention (so the existing `@relpath` resolution keeps matching).
 */
export function classifyMention(token: string): ParsedMention {
  for (const [pfx, kind] of Object.entries(PREFIXES)) {
    if (token.toLowerCase().startsWith(pfx)) {
      return { kind, query: token.slice(pfx.length), token };
    }
  }
  return { kind: "file", query: token, token };
}

export interface ActiveMention extends ParsedMention {
  /** index of the `@` in the text (for splicing on completion). */
  start: number;
}

/** Chars allowed in a mention token after `@` (letters/digits/_ + `:./-`). */
const TOKEN_CHARS = /[\w:./-]/;

/**
 * Caret-anchored detection: scan BACK from `caret` for the last `@` not preceded by a
 * word char (so an email/`a@b` doesn't trigger), with only token chars between it and the
 * caret. Returns null when no active mention (so an earlier `@file` never hijacks it).
 */
export function detectActiveMention(text: string, caret: number): ActiveMention | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  let i = pos - 1;
  while (i >= 0) {
    const ch = text[i] as string;
    if (ch === "@") break;
    if (!TOKEN_CHARS.test(ch)) return null; // a space/newline before an @ → not in a mention
    i -= 1;
  }
  if (i < 0 || text[i] !== "@") return null;
  const before = i > 0 ? (text[i - 1] as string) : "";
  if (before && /\w/.test(before)) return null; // `foo@bar` (email) — not a mention
  const token = text.slice(i + 1, pos);
  return { start: i, ...classifyMention(token) };
}

/** Replace the active mention token with `replacement` (+ a trailing space). */
export function replaceMention(text: string, active: ActiveMention, replacement: string): string {
  const end = active.start + 1 + active.token.length;
  return `${text.slice(0, active.start)}${replacement}${text.slice(end)}`;
}

/* ── attach-builders (pure math; the IO caller feeds file text in) ───────────── */

/** A bounded slice of a file around a 1-based `line` (for a symbol definition region). */
export function sliceSymbolRegion(text: string, line1: number, before = 3, after = 20): string {
  const lines = text.split("\n");
  const idx = Math.max(0, Math.min(line1 - 1, lines.length - 1));
  const start = Math.max(0, idx - before);
  const end = Math.min(lines.length, idx + after + 1);
  const head = start > 0 ? `… (from line ${start + 1})\n` : "";
  const tail = end < lines.length ? "\n…" : "";
  return `${head}${lines.slice(start, end).join("\n")}${tail}`;
}

/** Cap a set of read files by BOTH count and bytes; stops at the first breach. */
export function capFolderFiles(
  files: readonly { path: string; text: string }[],
  maxFiles = 20,
  maxBytes = 40_000,
): { kept: { path: string; text: string }[]; truncated: boolean } {
  const kept: { path: string; text: string }[] = [];
  let bytes = 0;
  let truncated = false;
  for (const f of files) {
    if (kept.length >= maxFiles) {
      truncated = true;
      break;
    }
    bytes += f.text.length;
    if (bytes > maxBytes) {
      truncated = true;
      break;
    }
    kept.push(f);
  }
  return { kept, truncated };
}

/** Discover repo markdown docs matching a query (README/**.md), ranked by path match. */
export function discoverDocs(files: readonly string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  const md = files.filter((f) => f.toLowerCase().endsWith(".md"));
  const scored = md
    .map((f) => {
      const low = f.toLowerCase();
      const base = low.split("/").pop() ?? low;
      let score = 0;
      if (q && low.includes(q)) score += 2;
      if (base.startsWith("readme")) score += 3;
      if (low.includes("/docs/") || low.startsWith("docs/")) score += 1;
      return { f, score };
    })
    .filter((s) => (q ? s.f.toLowerCase().includes(q) : true))
    .sort((a, b) => b.score - a.score || a.f.localeCompare(b.f));
  return scored.slice(0, limit).map((s) => s.f);
}

/** Unique parent directories from a file list (for the @folder picker). */
export function folderList(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const slash = f.lastIndexOf("/");
    if (slash > 0) dirs.add(f.slice(0, slash));
  }
  return [...dirs].sort();
}

/* ── chip reducer (a resolved mention's context, removable before send) ──────── */

export interface MentionChip {
  id: string;
  kind: MentionKind;
  label: string;
  /** the resolved context block appended to the outgoing message. */
  block: string;
}

export function addChip(chips: readonly MentionChip[], chip: MentionChip): MentionChip[] {
  if (chips.some((c) => c.id === chip.id)) return [...chips]; // dedupe by id
  return [...chips, chip];
}

export function removeChip(chips: readonly MentionChip[], id: string): MentionChip[] {
  return chips.filter((c) => c.id !== id);
}

/** Re-derive the outgoing context from the LIVE chips at send time (not a mutated string). */
export function chipsToContext(chips: readonly MentionChip[]): string {
  return chips.map((c) => c.block).join("\n\n");
}
