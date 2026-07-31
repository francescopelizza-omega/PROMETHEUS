/**
 * ide/state/usages-store.ts — the live Find-Usages tool-window state (APP-023).
 *
 * A thin zustand wrapper over the results the EditorPane fan-in produces (LSP references
 * with a whole-word grep fallback, merged + deduped by the pure `usages` module). SearchPanel
 * reads this in its "usages mode"; the fan-in writes it. Renderer-local — no engine, no IPC.
 */

import { create } from "zustand";

import type { Usage, UsageScope } from "./usages.js";

interface UsagesStore {
  /** the tool window is showing usages (vs SearchPanel's normal search UI). */
  active: boolean;
  /** the symbol Find-Usages ran on (the header label). */
  symbol: string;
  /** the canonical uri of the origin file (for the Current-file / Directory scope filters). */
  originUri: string;
  /** the merged, deduped usages (1-based line/column). */
  results: Usage[];
  scope: UsageScope;
  /** a fan-in is in flight (the panel shows "Searching…"). */
  loading: boolean;
  /** open the panel + mark a find in flight for `symbol`. */
  begin(symbol: string, originUri: string): void;
  /** land the fan-in results. */
  setResults(symbol: string, originUri: string, results: Usage[]): void;
  setScope(scope: UsageScope): void;
  /** close usages mode (back to search). */
  clear(): void;
}

export const useUsagesStore = create<UsagesStore>((set) => ({
  active: false,
  symbol: "",
  originUri: "",
  results: [],
  scope: "all",
  loading: false,
  begin: (symbol, originUri) =>
    set({ active: true, symbol, originUri, results: [], scope: "all", loading: true }),
  setResults: (symbol, originUri, results) =>
    set({ active: true, symbol, originUri, results, loading: false }),
  setScope: (scope) => set({ scope }),
  clear: () =>
    set({ active: false, symbol: "", originUri: "", results: [], scope: "all", loading: false }),
}));
