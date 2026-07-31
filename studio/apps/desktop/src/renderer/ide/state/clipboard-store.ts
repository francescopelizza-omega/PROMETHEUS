/**
 * ide/state/clipboard-store.ts — the clipboard history ring (JetBrains "Paste from
 * History" ⌘⇧V · VS Code clipboard-ring parity; plan file 01).
 *
 * The editor captures every copy/cut of selected text (EditorPane wires the DOM
 * copy/cut events) and pushes it here; the ClipboardHistory picker reads `entries` and
 * dispatches `ide:insert-text` to paste a chosen one at the caret. Most-recent-first,
 * de-duplicated, capped. PURE ring math (`pushClip`) is node:test-ed separately.
 *
 * Renderer-local: no engine, no IPC — the history never leaves the renderer (clipboard
 * text can be sensitive; keeping it out of the engine/telemetry is deliberate).
 */

import { create } from "zustand";

export const CLIP_CAP = 30;

/**
 * Push `text` onto the ring: drop an existing identical entry (so a re-copy floats to
 * the top instead of duplicating), prepend, and cap at `cap`. Whitespace-only text is
 * ignored (returns the ring unchanged) — never pollute history with blank copies.
 */
export function pushClip(entries: readonly string[], text: string, cap = CLIP_CAP): string[] {
  if (!text.trim()) return [...entries];
  const deduped = entries.filter((e) => e !== text);
  return [text, ...deduped].slice(0, Math.max(1, cap));
}

interface ClipboardState {
  /** most-recent-first history of copied/cut text. */
  entries: string[];
  push(text: string): void;
  clear(): void;
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  entries: [],
  push: (text) => set((s) => ({ entries: pushClip(s.entries, text) })),
  clear: () => set({ entries: [] }),
}));
