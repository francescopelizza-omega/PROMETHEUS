/**
 * ide/state/code-index-store.ts — the live wrapper around the PURE code-index model
 * (code-index.ts, plan 39). Holds the current symbol index + the WORD index (APP-065) +
 * dumb-mode status; the rebuild logic (fs walk / LSP async) lives in the editor route and
 * pushes results here. Incremental updates go through the PURE update/remove fns so a single
 * file change never rebuilds the world (immutable new Map/array → zustand re-renders).
 *
 * Kept separate from code-index.ts so that file stays react/zustand-free + node:test-ed.
 */

import { create } from "zustand";

import {
  type CodeIndex,
  type IndexStatus,
  type IndexedSymbol,
  type WordIndex,
  initialStatus,
  removeIndexEntry,
  removeWordEntry,
  updateIndexEntry,
  updateWordEntry,
} from "./code-index.js";

interface CodeIndexStore {
  index: CodeIndex;
  /** word → files, the repo-wide fuzzy-shortlist + agent-context source (APP-065). */
  words: WordIndex;
  status: IndexStatus;
  setIndex(index: CodeIndex): void;
  setWords(words: WordIndex): void;
  setStatus(status: IndexStatus): void;
  /** incremental: re-index ONE file's symbols + words in place (immutable). */
  upsertFile(uri: string, symbols: readonly IndexedSymbol[], text: string): void;
  /** incremental (fs.change): re-index ONE file's WORDS only (symbols stay LSP/repomap-sourced). */
  upsertWords(uri: string, text: string): void;
  /** incremental: drop ONE file (a delete on disk) from both indexes. */
  dropFile(uri: string): void;
  reset(): void;
}

const EMPTY: CodeIndex = { symbols: [], files: [] };

export const useCodeIndexStore = create<CodeIndexStore>((set) => ({
  index: EMPTY,
  words: new Map(),
  status: initialStatus(),
  setIndex: (index) => set({ index }),
  setWords: (words) => set({ words }),
  setStatus: (status) => set({ status }),
  upsertFile: (uri, symbols, text) =>
    set((s) => ({
      index: updateIndexEntry(s.index, uri, symbols),
      words: updateWordEntry(s.words, uri, text),
    })),
  upsertWords: (uri, text) => set((s) => ({ words: updateWordEntry(s.words, uri, text) })),
  dropFile: (uri) =>
    set((s) => ({
      index: removeIndexEntry(s.index, uri),
      words: removeWordEntry(s.words, uri),
    })),
  reset: () => set({ index: EMPTY, words: new Map(), status: initialStatus() }),
}));
