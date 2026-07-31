/**
 * ide/state/inline-blame-store.ts — the persisted opt-in for inline blame (APP-083).
 *
 * A tiny zustand store mirroring editor-vision-store: loads from localStorage on init,
 * persists on toggle (fail-soft), and fires listeners so the EditorPane re-fetches /
 * clears its current-line blame decoration the instant the toggle flips — without
 * re-mounting the editor. Default OFF (inline blame is opt-in, like GitLens).
 */

import { create } from "zustand";

export const INLINE_BLAME_KEY = "prometheus.editor.inlineBlame.v1";

function load(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(INLINE_BLAME_KEY) === "1";
  } catch {
    return false;
  }
}

function persist(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INLINE_BLAME_KEY, enabled ? "1" : "0");
  } catch {
    /* quota / private mode — the toggle just won't persist this run */
  }
}

/** Listeners (the EditorPane blame wiring) that re-run when the toggle flips. */
const changeListeners = new Set<() => void>();
export function onInlineBlameChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
export function fireInlineBlameChange(): void {
  for (const fn of changeListeners) fn();
}

interface InlineBlameStore {
  enabled: boolean;
  toggle(): void;
  set(enabled: boolean): void;
}

export const useInlineBlameStore = create<InlineBlameStore>((set, get) => ({
  enabled: load(),
  toggle: () => {
    const enabled = !get().enabled;
    set({ enabled });
    persist(enabled);
    fireInlineBlameChange();
  },
  set: (enabled) => {
    set({ enabled });
    persist(enabled);
    fireInlineBlameChange();
  },
}));
