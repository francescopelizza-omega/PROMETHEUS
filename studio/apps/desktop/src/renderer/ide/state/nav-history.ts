// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/nav-history.ts — the editor navigation stack (JetBrains Back/Forward ⌘[/⌘]
 * + "Last Edit Location" ⌘⇧⌫ · VS Code Alt+←/→ parity; plan file 05).
 *
 * The caret feed (`ide:cursor-position`) is fed into `record`; the reducer coalesces
 * nearby moves on the same file (so ordinary typing/scrolling doesn't flood the stack)
 * and pushes a new entry only on a genuine jump (different file, or > MIN_GAP lines). A
 * back/forward move walks the pointer; a NEW navigation truncates the forward history.
 * `lastEdit` tracks the most recent edit position for a one-key jump-back.
 *
 * PURE reducer (`recordNav`/`navBack`/`navForward`) is node:test-ed; the Zustand store
 * is the thin live wrapper. Renderer-local — no engine, no IPC.
 */

import { create } from "zustand";

export interface NavLoc {
  uri: string;
  line: number; // 1-based
  column: number; // 1-based
}

export interface NavState {
  entries: NavLoc[];
  /** pointer into `entries` for the current location (-1 = empty). */
  index: number;
}

export const NAV_CAP = 50;
/** Same file + closer than this many lines ⇒ "same spot" (coalesce, don't push). */
export const MIN_GAP = 8;

export function initialNav(): NavState {
  return { entries: [], index: -1 };
}

function isSameSpot(a: NavLoc, b: NavLoc): boolean {
  return a.uri === b.uri && Math.abs(a.line - b.line) < MIN_GAP;
}

/**
 * Record a navigation. If it lands near the current entry (same file, < MIN_GAP lines)
 * it updates that entry in place (keeping the pointer + forward history); otherwise it
 * truncates any forward history, pushes, and caps the stack from the front.
 */
export function recordNav(state: NavState, loc: NavLoc): NavState {
  const cur = state.entries[state.index];
  if (cur && isSameSpot(cur, loc)) {
    const entries = state.entries.slice();
    entries[state.index] = loc;
    return { entries, index: state.index };
  }
  const kept = state.entries.slice(0, state.index + 1);
  kept.push(loc);
  let entries = kept;
  let index = entries.length - 1;
  if (entries.length > NAV_CAP) {
    const drop = entries.length - NAV_CAP;
    entries = entries.slice(drop);
    index -= drop;
  }
  return { entries, index };
}

/** Predicate: is the entry's file still reachable? (dead entries — closed/deleted files —
 *  are walked PAST on traversal.) Defaults to "everything is alive" so the pre-APP-022
 *  callers (and tests) keep their exact behavior. */
export type IsAlive = (uri: string) => boolean;

export function navBack(
  state: NavState,
  isAlive: IsAlive = () => true,
): { state: NavState; loc: NavLoc } | null {
  // walk backward past any DEAD entry (its file was closed/deleted) to the first live one.
  for (let index = state.index - 1; index >= 0; index--) {
    const loc = state.entries[index];
    if (loc && isAlive(loc.uri)) return { state: { entries: state.entries, index }, loc };
  }
  return null;
}

export function navForward(
  state: NavState,
  isAlive: IsAlive = () => true,
): { state: NavState; loc: NavLoc } | null {
  for (let index = state.index + 1; index < state.entries.length; index++) {
    const loc = state.entries[index];
    if (loc && isAlive(loc.uri)) return { state: { entries: state.entries, index }, loc };
  }
  return null;
}

/**
 * Drop every DEAD entry from the stack (a file that was closed/deleted), re-anchoring the
 * pointer on the nearest surviving entry at or before the old current (so Recent Locations
 * and future traversal never re-surface a dead spot). Returns the SAME state ref when
 * nothing is pruned (cheap no-op for the common case). Pure + immutable.
 */
export function pruneNav(state: NavState, isAlive: IsAlive): NavState {
  const kept: { loc: NavLoc; i: number }[] = [];
  for (let i = 0; i < state.entries.length; i++) {
    const loc = state.entries[i];
    if (loc && isAlive(loc.uri)) kept.push({ loc, i });
  }
  if (kept.length === state.entries.length) return state; // nothing dead — no churn
  let index = -1;
  for (let k = 0; k < kept.length; k++) {
    if (kept[k]!.i <= state.index) index = k;
  }
  if (index === -1 && kept.length > 0) index = 0; // all survivors are after the old current
  return { entries: kept.map((x) => x.loc), index };
}

interface NavStore extends NavState {
  lastEdit: NavLoc | null;
  record(loc: NavLoc): void;
  /** move back to the nearest LIVE earlier entry (skips dead ones via `isAlive`); returns
   *  the target (caller opens+reveals) or null at the start. */
  goBack(isAlive?: IsAlive): NavLoc | null;
  goForward(isAlive?: IsAlive): NavLoc | null;
  /** drop dead entries from the stack (a file was closed/deleted). */
  prune(isAlive: IsAlive): void;
  setLastEdit(loc: NavLoc): void;
}

export const useNavStore = create<NavStore>((set, get) => ({
  entries: [],
  index: -1,
  lastEdit: null,
  record: (loc) =>
    set((s) => {
      const next = recordNav({ entries: s.entries, index: s.index }, loc);
      return { entries: next.entries, index: next.index };
    }),
  goBack: (isAlive) => {
    const r = navBack({ entries: get().entries, index: get().index }, isAlive);
    if (!r) return null;
    set({ entries: r.state.entries, index: r.state.index });
    return r.loc;
  },
  goForward: (isAlive) => {
    const r = navForward({ entries: get().entries, index: get().index }, isAlive);
    if (!r) return null;
    set({ entries: r.state.entries, index: r.state.index });
    return r.loc;
  },
  prune: (isAlive) =>
    set((s) => {
      const next = pruneNav({ entries: s.entries, index: s.index }, isAlive);
      return { entries: next.entries, index: next.index };
    }),
  setLastEdit: (loc) => set({ lastEdit: loc }),
}));
