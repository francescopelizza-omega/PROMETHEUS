// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/shared/codebase-overview/useCodebaseOverview.ts — "meet your codebase"'s data hook
 * (roadmap point 6).
 *
 * UNLIKE useModelHealth.ts/useBudgetStatus.ts, this does NOT poll — a repo-map walk is a real,
 * potentially-slow scan of the whole open workspace (see codebase-overview-ipc.ts's own header:
 * it can block the main process for its duration on a large repo), so it must only ever run when
 * the user explicitly asks, never silently on an interval or on mount.
 *
 * Renderer-SANDBOXED (C5): react + `window.prometheus.codebaseOverview` only.
 */
import { useCallback, useState } from "react";

export interface CodebaseOverviewCountView {
  key: string;
  count: number;
}

export interface CodebaseOverviewView {
  fileCount: number;
  truncated: boolean;
  topExtensions: CodebaseOverviewCountView[];
  topDirs: CodebaseOverviewCountView[];
  detectedStacks: string[];
  readmePath?: string;
  sampleSymbols: string[];
}

export interface UseCodebaseOverviewResult {
  overview: CodebaseOverviewView | undefined;
  loading: boolean;
  error: string | undefined;
  /** Walk the open workspace and populate `overview`. Safe to call again (regenerates). */
  generate: () => Promise<void>;
}

export function useCodebaseOverview(): UseCodebaseOverviewResult {
  const [overview, setOverview] = useState<CodebaseOverviewView | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    const res = await window.prometheus?.codebaseOverview?.generate();
    setLoading(false);
    if (!res || !res.ok || !res.overview) {
      setError(res?.error ?? "codebase overview IPC unavailable");
      return;
    }
    setOverview(res.overview);
  }, []);

  return { overview, loading, error, generate };
}

export default useCodebaseOverview;
