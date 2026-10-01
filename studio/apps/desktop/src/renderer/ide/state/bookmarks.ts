// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/bookmarks.ts — persistent line bookmarks + numbered mnemonics (APP-061).
 *
 * A PURE, react-free model (toggle / mnemonic-steal / line-shift / serialize) + a thin
 * zustand store wrapper that persists per WORKSPACE ROOT to localStorage (fail-soft,
 * mirroring stores.ts's ai-session persistence) so project A's bookmarks never leak into
 * project B. The pure reducers are node:test-covered without a DOM; the store is the thin
 * glue EditorPane / the Bookmarks window / the digit chords read.
 *
 * Renderer-SANDBOXED (C5): zustand + local pure logic only — no monaco/electron/node.
 */
import { create } from "zustand";

import type { GutterRegistry } from "./gutter-decorations.js";

/** A single bookmark: a line in a file, optionally holding a 0–9 mnemonic digit. */
export interface Bookmark {
  uri: string;
  /** 1-based line (Monaco convention). */
  line: number;
  label?: string;
  /** 0–9 numbered mnemonic; at most ONE bookmark holds each digit (steal semantics). */
  mnemonic?: number;
}

export interface BookmarkState {
  list: Bookmark[];
}

export const EMPTY_BOOKMARKS: BookmarkState = { list: [] };

/** Find the bookmark at a location, if any. */
export function findAt(state: BookmarkState, uri: string, line: number): Bookmark | undefined {
  return state.list.find((b) => b.uri === uri && b.line === line);
}

export function isBookmarked(state: BookmarkState, uri: string, line: number): boolean {
  return findAt(state, uri, line) !== undefined;
}

/** Toggle a bookmark at (uri,line): add when absent, remove when present. Idempotent pairs. */
export function toggleBookmark(
  state: BookmarkState,
  uri: string,
  line: number,
  label?: string,
): BookmarkState {
  if (isBookmarked(state, uri, line)) return removeBookmark(state, uri, line);
  const bm: Bookmark = { uri, line, ...(label ? { label } : {}) };
  return { list: [...state.list, bm] };
}

/** Remove the bookmark at (uri,line) (same-content no-op when absent). */
export function removeBookmark(state: BookmarkState, uri: string, line: number): BookmarkState {
  const rest = state.list.filter((b) => !(b.uri === uri && b.line === line));
  return rest.length === state.list.length ? state : { list: rest };
}

/**
 * Assign digit `mnemonic` (0–9) to the bookmark at (uri,line), creating the bookmark if
 * absent. STEALS the digit from any prior holder in the SAME single update, so no two
 * bookmarks ever claim the same digit (the load-bearing invariant). A digit outside 0–9 is
 * a no-op.
 */
export function setMnemonic(
  state: BookmarkState,
  uri: string,
  line: number,
  mnemonic: number,
): BookmarkState {
  if (!Number.isInteger(mnemonic) || mnemonic < 0 || mnemonic > 9) return state;
  const list: Bookmark[] = [];
  let placed = false;
  for (const b of state.list) {
    // strip the digit from its prior holder.
    const cleared = b.mnemonic === mnemonic ? stripMnemonic(b) : b;
    if (cleared.uri === uri && cleared.line === line) {
      list.push({ ...cleared, mnemonic });
      placed = true;
    } else {
      list.push(cleared);
    }
  }
  if (!placed) list.push({ uri, line, mnemonic });
  return { list };
}

function stripMnemonic(b: Bookmark): Bookmark {
  if (b.mnemonic === undefined) return b;
  const { mnemonic: _drop, ...rest } = b;
  return rest;
}

/** Clear whichever bookmark holds `digit` (same-content no-op when unheld). */
export function clearMnemonic(state: BookmarkState, digit: number): BookmarkState {
  let changed = false;
  const list = state.list.map((b) => {
    if (b.mnemonic === digit) {
      changed = true;
      return stripMnemonic(b);
    }
    return b;
  });
  return changed ? { list } : state;
}

/** The bookmark holding `digit`, if any. */
export function byMnemonic(state: BookmarkState, digit: number): Bookmark | undefined {
  return state.list.find((b) => b.mnemonic === digit);
}

/** All bookmarks in a file, ascending by line. */
export function forUri(state: BookmarkState, uri: string): Bookmark[] {
  return state.list.filter((b) => b.uri === uri).sort((a, b) => a.line - b.line);
}

/** Every bookmark, grouped by uri (path-sorted) then line — the Bookmarks window order. */
export function allSorted(state: BookmarkState): Bookmark[] {
  return [...state.list].sort((a, b) => a.uri.localeCompare(b.uri) || a.line - b.line);
}

/**
 * Apply a text-edit line delta to a file's bookmarks. The edit begins at `changeLine`
 * (1-based) and shifts the lines BELOW it by `delta` (positive = lines inserted, negative =
 * removed). A bookmark whose line falls inside a DELETED range CLAMPS to `changeLine` — it
 * must never vanish silently (the gotcha). Bookmarks at/above the change are untouched.
 * Collisions after clamping merge (a mnemonic-holder wins) so the digit invariant survives.
 */
export function shiftLines(
  state: BookmarkState,
  uri: string,
  changeLine: number,
  delta: number,
): BookmarkState {
  if (delta === 0) return state;
  const shifted: Bookmark[] = [];
  let touched = false;
  for (const b of state.list) {
    if (b.uri !== uri || b.line <= changeLine) {
      shifted.push(b);
      continue;
    }
    const moved = Math.max(changeLine, b.line + delta);
    if (moved !== b.line) touched = true;
    shifted.push({ ...b, line: moved });
  }
  if (!touched) return state;
  return { list: dedupeByLine(shifted) };
}

/** Merge bookmarks that collided on the same (uri,line): keep a mnemonic-holder if present. */
function dedupeByLine(list: Bookmark[]): Bookmark[] {
  const seen = new Map<string, Bookmark>();
  for (const b of list) {
    const key = `${b.uri}\x00${b.line}`;
    const prev = seen.get(key);
    if (!prev) seen.set(key, b);
    else if (prev.mnemonic === undefined && b.mnemonic !== undefined) seen.set(key, b);
  }
  return [...seen.values()];
}

/* ── persistence (fail-soft, validated) ─────────────────────────────────────── */

export function serialize(state: BookmarkState): string {
  return JSON.stringify(state.list);
}

/** Parse a persisted blob → BookmarkState, dropping malformed rows (fail-soft → EMPTY). */
export function deserialize(raw: string | null | undefined): BookmarkState {
  if (!raw) return EMPTY_BOOKMARKS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_BOOKMARKS;
    const list: Bookmark[] = [];
    // enforce the one-holder-per-mnemonic invariant on load — a hand-edited/corrupt blob with
    // two bookmarks claiming the same digit would otherwise make byMnemonic ambiguous.
    const usedMnemonics = new Set<number>();
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Bookmark).uri === "string" &&
        Number.isInteger((item as Bookmark).line) &&
        (item as Bookmark).line >= 1
      ) {
        const b = item as Bookmark;
        const bm: Bookmark = { uri: b.uri, line: b.line };
        if (typeof b.label === "string") bm.label = b.label;
        if (
          Number.isInteger(b.mnemonic) &&
          (b.mnemonic as number) >= 0 &&
          (b.mnemonic as number) <= 9 &&
          !usedMnemonics.has(b.mnemonic as number)
        ) {
          bm.mnemonic = b.mnemonic;
          usedMnemonics.add(b.mnemonic as number);
        }
        list.push(bm);
      }
    }
    return { list };
  } catch {
    return EMPTY_BOOKMARKS;
  }
}

/** localStorage key for a workspace root (per-root isolation). */
export function storageKeyFor(root: string): string {
  return `prometheus.bookmarks.${root}`;
}

/* ── gutter projection (fed into the shared APP-011 decoration registry) ─────── */

/** The glyph CSS class for a bookmark — a per-digit class when it holds a mnemonic. */
export function bookmarkGlyphClass(mnemonic: number | undefined): string {
  return mnemonic === undefined ? "bookmark-glyph" : `bookmark-glyph-${mnemonic}`;
}

/** A gutter decoration input (mirrors gutter-decorations' GutterDecorationInput). */
export interface BookmarkGutterInput {
  line: number;
  glyphClassName: string;
  hoverMessage: string;
  order: number;
}

/** Project a file's bookmarks → gutter decoration inputs for the shared registry. */
export function gutterInputsFor(state: BookmarkState, uri: string): BookmarkGutterInput[] {
  return forUri(state, uri).map((b) => ({
    line: b.line,
    glyphClassName: bookmarkGlyphClass(b.mnemonic),
    hoverMessage:
      b.mnemonic !== undefined
        ? `Bookmark ${b.mnemonic}${b.label ? `: ${b.label}` : ""}`
        : `Bookmark${b.label ? `: ${b.label}` : ""}`,
    order: 50, // below breakpoints/run icons — they win the visible glyph on a shared line
  }));
}

/** The distinct uris that currently hold at least one bookmark. */
export function bookmarkedUris(state: BookmarkState): string[] {
  return [...new Set(state.list.map((b) => b.uri))];
}

/* ── the thin zustand store (renderer glue over the pure reducers) ───────────── */

/** Read localStorage fail-soft (undefined outside a DOM / on a throw). */
function loadFor(root: string | null): BookmarkState {
  if (!root || typeof window === "undefined" || !window.localStorage) return EMPTY_BOOKMARKS;
  try {
    return deserialize(window.localStorage.getItem(storageKeyFor(root)));
  } catch {
    return EMPTY_BOOKMARKS;
  }
}

function persistFor(root: string | null, state: BookmarkState): void {
  if (!root || typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(storageKeyFor(root), serialize(state));
  } catch {
    /* quota / disabled storage — bookmarks stay in-memory this session */
  }
}

export interface BookmarksStore {
  root: string | null;
  state: BookmarkState;
  /** switch the active workspace root — loads THAT root's bookmarks from disk. */
  setRoot(root: string | null): void;
  toggle(uri: string, line: number, label?: string): void;
  remove(uri: string, line: number): void;
  setMnemonic(uri: string, line: number, digit: number): void;
  clearMnemonic(digit: number): void;
  shift(uri: string, changeLine: number, delta: number): void;
}

/** Apply a pure reducer to the current root's state + persist it. */
function mutate(
  get: () => BookmarksStore,
  set: (p: Partial<BookmarksStore>) => void,
  fn: (s: BookmarkState) => BookmarkState,
): void {
  const { root, state } = get();
  const next = fn(state);
  if (next === state) return;
  persistFor(root, next);
  set({ state: next });
}

export const useBookmarksStore = create<BookmarksStore>((set, get) => ({
  root: null,
  state: EMPTY_BOOKMARKS,
  setRoot: (root): void => {
    if (root === get().root) return;
    set({ root, state: loadFor(root) });
  },
  toggle: (uri, line, label): void => mutate(get, set, (s) => toggleBookmark(s, uri, line, label)),
  remove: (uri, line): void => mutate(get, set, (s) => removeBookmark(s, uri, line)),
  setMnemonic: (uri, line, digit): void =>
    mutate(get, set, (s) => setMnemonic(s, uri, line, digit)),
  clearMnemonic: (digit): void => mutate(get, set, (s) => clearMnemonic(s, digit)),
  shift: (uri, changeLine, delta): void =>
    mutate(get, set, (s) => shiftLines(s, uri, changeLine, delta)),
}));

/** The gutter-registry provider id for bookmark glyphs. */
export const BOOKMARK_PROVIDER = "bookmarks";

/**
 * Wire the bookmarks store → the shared gutter-decoration registry (APP-011): push each
 * bookmarked file's glyphs, clear files that lost their last bookmark. Idempotent replays are
 * same-ref no-ops. Mirrors wireBreakpointGutter but keys by the model uri directly (bookmarks
 * already store the model-uri string), so no monaco path conversion is needed. Returns an
 * unsubscribe. Pure of monaco/DOM — node:test-able with a fake registry.
 */
export function wireBookmarkGutter(
  registry: Pick<GutterRegistry, "register" | "replaceForProvider">,
  store: Pick<typeof useBookmarksStore, "getState" | "subscribe"> = useBookmarksStore,
): () => void {
  registry.register(BOOKMARK_PROVIDER);
  let decorated = new Set<string>();
  const sync = (): void => {
    const s = store.getState().state;
    const next = new Set<string>();
    for (const uri of bookmarkedUris(s)) {
      next.add(uri);
      registry.replaceForProvider(BOOKMARK_PROVIDER, uri, gutterInputsFor(s, uri));
    }
    for (const uri of decorated) {
      if (!next.has(uri)) registry.replaceForProvider(BOOKMARK_PROVIDER, uri, []);
    }
    decorated = next;
  };
  const unsub = store.subscribe(sync);
  sync();
  return unsub;
}
