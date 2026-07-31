/**
 * hooks/useEngine.ts — a framework-agnostic bridge-query wrapper (08 §3).
 *
 * @prometheus/ui is renderer-sandboxed (C5) and TanStack-Query-agnostic, so this is
 * a thin, dependency-free async-state hook: the HOST supplies a fetcher that calls
 * window.prometheus.* (the only engine seam); this hook just tracks loading/data/
 * error + a refetch, never spawning anything itself. The desktop can wrap its
 * TanStack hooks on top; a CLI web-help view can use this directly.
 */

import { useCallback, useEffect, useState } from "react";

export interface UseEngineState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch(): void;
}

/**
 * Run an async bridge fetcher, re-running when `deps` change. Stale results are
 * dropped (the latest call wins) so a fast re-trigger never paints an old payload.
 */
export function useEngine<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
): UseEngineState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback((): void => setNonce((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is caller-supplied by contract and `nonce` drives refetch; `fetcher` is intentionally excluded so an inline fetcher does not re-run the effect on every render.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    void fetcher()
      .then((value) => {
        if (alive) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [...deps, nonce]);

  return { data, error, loading, refetch };
}
