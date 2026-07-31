/**
 * ide/state/coverage-store.ts — the current coverage report (APP-086).
 *
 * The Coverage window sets a report (from `coverageRun`/`coverageImport` or a merge);
 * EditorPane subscribes and paints covered/uncovered gutter stripes for the active file.
 * A fire/subscribe seam (mirroring inline-blame-store) lets the editor re-apply stripes
 * the instant a run/merge lands — without re-mounting.
 */

import { create } from "zustand";

import type { IdeCoverageReport } from "../../../shared/ipc-contract.js";

const changeListeners = new Set<() => void>();
export function onCoverageChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
function fireCoverageChange(): void {
  for (const fn of changeListeners) fn();
}

interface CoverageStore {
  report: IdeCoverageReport | null;
  setReport(report: IdeCoverageReport | null): void;
  clear(): void;
}

export const useCoverageStore = create<CoverageStore>((set) => ({
  report: null,
  setReport: (report) => {
    set({ report });
    fireCoverageChange();
  },
  clear: () => {
    set({ report: null });
    fireCoverageChange();
  },
}));

/**
 * Find the report entry for an editor model by its absolute fsPath. coverage.py keys can
 * be absolute OR project-relative, so match on equality then on a path-suffix (the model
 * path ends with the report key, or vice-versa) — never a partial-segment false positive.
 */
export function coverageEntryForPath(
  report: IdeCoverageReport | null,
  fsPath: string,
): IdeCoverageReport["perFile"][string] | undefined {
  if (!report) return undefined;
  const direct = report.perFile[fsPath];
  if (direct) return direct;
  // Prefer the LONGEST suffix match (most path segments) — returning the first suffix hit
  // mis-attributed coverage to a same-basename file in another directory (src/util.py vs
  // tests/util.py) depending on iteration order.
  let best: { entry: IdeCoverageReport["perFile"][string]; len: number } | undefined;
  for (const [key, entry] of Object.entries(report.perFile)) {
    if (fsPath === key) return entry; // an exact key wins outright
    let len = 0;
    if (fsPath.endsWith(`/${key}`)) len = key.length;
    else if (key.endsWith(`/${fsPath}`)) len = fsPath.length;
    if (len > 0 && (!best || len > best.len)) best = { entry, len };
  }
  return best?.entry;
}
