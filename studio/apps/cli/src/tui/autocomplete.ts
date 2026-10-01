// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tui/autocomplete.ts — the slash-command autocomplete (Claude-Code-style).
 *
 * Typing "/" opens a dropdown ABOVE the composer; ↑/↓ move the selection, Tab/Enter
 * complete it, Esc closes. Ranking is prefix-first then fuzzy-subsequence so "/inst"
 * surfaces `install` and "/scn" still finds `scan`. The selected row is painted with
 * the high-contrast violet→cyan gradient bar (palette.selectionBar). PURE: state
 * transitions + a render that takes the resolved color caps — fully unit-testable.
 */
import { type ColorCaps, painter, selectionBar } from "./palette.js";
import { clipToWidth, padToWidth, stringWidth } from "./width.js";

/** A completable command (mapped from the host's SlashCmd registry). */
export interface AcItem {
  name: string;
  summary: string;
  aliases?: readonly string[];
  /** usage hint shown after the name (e.g. "<target>"). */
  args?: string;
  group?: string;
}

/** The live dropdown state. */
export interface AcState {
  /** the matched items, best-first. */
  items: AcItem[];
  /** the highlighted index (always valid when items is non-empty). */
  index: number;
  /** the query that produced `items` (the text after the leading "/"). */
  query: string;
}

const EMPTY: AcState = { items: [], index: 0, query: "" };

/* ── ranking ──────────────────────────────────────────────────────────────── */

/** Is `q` a subsequence of `s` (chars in order, gaps allowed)? Returns the gap count or -1. */
function subseqGaps(q: string, s: string): number {
  let i = 0;
  let gaps = 0;
  let started = false;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) {
      if (started && j > 0 && s[j - 1] !== q[i - 1]) gaps += 1;
      started = true;
      i += 1;
    }
  }
  return i === q.length ? gaps : -1;
}

/** Score one item against a lowercased query. Higher = better; -1 = no match. */
function scoreItem(item: AcItem, q: string): number {
  if (q === "") return 1; // empty query → everything matches (listed)
  const name = item.name.toLowerCase();
  if (name === q) return 1000;
  if (name.startsWith(q)) return 850 - name.length;
  for (const a of item.aliases ?? []) {
    const al = a.toLowerCase();
    if (al === q) return 920;
    if (al.startsWith(q)) return 720 - al.length;
  }
  const idx = name.indexOf(q);
  if (idx >= 0) return 500 - idx;
  const gaps = subseqGaps(q, name);
  if (gaps >= 0) return 250 - gaps * 10;
  return -1;
}

/**
 * Rank the registry against the query (the chars AFTER the leading "/", up to the
 * first space). Empty query → all commands, alphabetical. Ties break alphabetically.
 */
export function rankSlash(query: string, all: readonly AcItem[]): AcItem[] {
  const q = query.toLowerCase();
  return all
    .map((item) => ({ item, score: scoreItem(item, q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .map((x) => x.item);
}

/* ── the slash trigger ────────────────────────────────────────────────────── */

/**
 * Should the autocomplete be open for this input + cursor, and if so what's the
 * query? Open only while the cursor is within the LEADING slash-word (no space yet) —
 * "/inst|" yes, "/install foo|" no (args are typed freely). Returns null when closed.
 */
export function slashQuery(input: string, cursor: number): string | null {
  if (!input.startsWith("/")) return null;
  // slice on CODE POINTS — `cursor` is a code-point index (astral-safe composer).
  const head = [...input].slice(0, cursor).join("");
  // a space ends the command token → stop completing the name.
  if (/\s/.test(head)) return null;
  return head.slice(1);
}

/* ── state transitions ────────────────────────────────────────────────────── */

/** (Re)compute the dropdown for an input line; closed → EMPTY. Keeps index in range. */
export function syncAutocomplete(
  input: string,
  cursor: number,
  all: readonly AcItem[],
  prev: AcState = EMPTY,
): AcState {
  const query = slashQuery(input, cursor);
  if (query === null) return EMPTY;
  const items = rankSlash(query, all);
  // A CHANGED query re-ranks the list, so the previous numeric index points at a DIFFERENT
  // command — clamping it kept a stale highlight alive ("/s" + ↓↓↓ then "tatus" ran
  // /plugin-status). Reset to the best match; only an unchanged query (cursor moved, list
  // re-synced) keeps the user's own ↑/↓ selection, clamped into range.
  const index =
    items.length === 0
      ? 0
      : query === prev.query
        ? Math.min(Math.max(prev.index, 0), items.length - 1)
        : 0;
  return { items, index, query };
}

export function isOpen(state: AcState): boolean {
  return state.items.length > 0;
}

/** Move the highlight by ±1 (wraps). */
export function moveAc(state: AcState, delta: number): AcState {
  if (state.items.length === 0) return state;
  const n = state.items.length;
  return { ...state, index: (((state.index + delta) % n) + n) % n };
}

/** The full input line after accepting the highlighted item ("/name "). null = none. */
export function acceptAc(state: AcState): string | null {
  const sel = state.items[state.index];
  return sel ? `/${sel.name} ` : null;
}

/**
 * Does this command REQUIRE an argument? Registry convention (slash-registry `verb()`):
 * `"<name>"` is required, `"[action]"` is optional. Only a REQUIRED arg may hold Enter —
 * an optional one must still run on the first press.
 */
export function requiresArg(item: AcItem): boolean {
  return typeof item.args === "string" && item.args.trim().startsWith("<");
}

/**
 * The line to SUBMIT when Enter is pressed on the highlighted item, given the live buffer.
 *
 * Two things `acceptAc` cannot do, both of which silently ran the WRONG command:
 *  - it always yields the PRIMARY name, so submitting it rewrote `/effort` → `/think`;
 *  - it drops whatever the user already typed after the command token.
 * So: keep the typed token when it is exactly the command's own name or one of its aliases,
 * else complete to the primary name, and re-attach the remainder of the buffer verbatim.
 * Returns null when nothing is highlighted.
 */
export function submitLine(state: AcState, input: string): string | null {
  const sel = state.items[state.index];
  if (!sel) return null;
  const typed = state.query;
  // `input` always starts with "/" + query (slashQuery slices a PREFIX of it).
  const rest = input.slice(1 + typed.length);
  const t = typed.toLowerCase();
  const exact =
    t === sel.name.toLowerCase() || (sel.aliases ?? []).some((a) => a.toLowerCase() === t);
  return `/${exact ? typed : sel.name}${rest}`;
}

/* ── render ───────────────────────────────────────────────────────────────── */

export interface DropdownOpts {
  /** max visible rows (default 8); the list scrolls a window around the selection. */
  maxRows?: number;
  /** row prefix before `item.name` (default "/" — the slash-command convention). Pass ""
   *  for a plain listing (e.g. the "@"-path dropdown, where a name shouldn't get a "/"
   *  glued on the front of it). */
  sigil?: string;
}

// The local `clip` this replaced counted CODE POINTS, not display columns, and knew nothing
// about ANSI — so a CJK name (two columns per glyph) overflowed the dropdown and a coloured
// row could be cut mid-escape. `tui/width.ts` is the one place that measures terminal cells,
// and using it here keeps this dropdown aligned with every other pane the TUI draws.

/**
 * Render the dropdown rows (shown ABOVE the composer). The selected row gets the
 * gradient selection bar; the rest show `name` (accent) + `summary` (muted). A long
 * list scrolls a window around the selection with a "+N more" footer.
 */
export function renderDropdown(
  state: AcState,
  width: number,
  caps: ColorCaps,
  opts: DropdownOpts = {},
): string[] {
  if (state.items.length === 0) return [];
  const p = painter(caps);
  const maxRows = Math.max(1, opts.maxRows ?? 8);
  const sigil = opts.sigil ?? "/";
  const n = state.items.length;
  const w = Math.max(12, width);

  // scroll window around the selection
  let top = 0;
  if (n > maxRows) top = Math.min(Math.max(0, state.index - (maxRows >> 1)), n - maxRows);
  const view = state.items.slice(top, top + maxRows);

  const nameW = Math.min(18, Math.max(...view.map((i) => stringWidth(i.name) + 1)) + 1);
  const rows: string[] = [];
  view.forEach((item, idx) => {
    const real = top + idx;
    const nm = `${sigil}${item.name}`;
    const hint = item.args ? ` ${item.args}` : "";
    const label = padToWidth(`${nm}${hint}`, nameW + 1);
    const line = clipToWidth(`${label} ${item.summary}`, w - 3);
    if (real === state.index) {
      // `▌` left edge marker (fg accent) survives NO_COLOR + colorblind; the rest is
      // the high-contrast gradient bar.
      rows.push(`${p.accent("▌")}${selectionBar(` ${line}`, w - 1, caps)}`);
    } else {
      const cut = clipToWidth(`${label}`, nameW + 1);
      const summary = clipToWidth(item.summary, w - nameW - 4);
      rows.push(`  ${p.accent(cut)} ${p.muted(summary)}`);
    }
  });
  if (n > maxRows) {
    const more = n - (top + view.length);
    const above = top;
    const tag =
      `${above > 0 ? `↑${above} ` : ""}${more > 0 ? `↓${more} more` : ""}`.trim() || "↑↓ to scroll";
    rows.push(`  ${p.muted(tag)}`);
  }
  return rows;
}
