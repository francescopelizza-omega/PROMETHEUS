// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/shared/model-health/useModelHealth.ts — Settings ▸ Model Health's data hook.
 *
 * Model health is GLOBAL, not per-workspace (an endpoint's transport/breaker/context-window
 * state isn't tied to one open project — mirrors `ModelHealthApi`'s own doc comment in
 * ipc-contract.ts), so unlike HooksPage's `reload` this takes no `workspaceRoot` and polls
 * `window.prometheus.modelHealth.list()` on an interval (not just on mount) — a user who
 * leaves the Settings page open should watch a breaker recover or a transport get
 * demonstrated LIVE, not have to navigate away and back to see the next turn's state.
 *
 * Renderer-SANDBOXED (C5): react + `@prometheus/core`'s plain `EndpointHealthRecord` type +
 * `window.prometheus.modelHealth` only.
 */
import type { EndpointHealthRecord } from "@prometheus/core/ai-model-health";
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 4000;

export interface UseModelHealthResult {
  records: EndpointHealthRecord[];
  loading: boolean;
  error: string | undefined;
  /** Re-fetch immediately, without waiting for the next poll tick. */
  refresh: () => void;
}

/**
 * Most-recently-used endpoint first (ISO 8601 timestamps sort lexicographically, so a plain
 * string comparison is correct here — no `Date` parsing needed). Pure + exported for its own
 * test coverage.
 */
export function sortByLastUsedDesc(
  records: readonly EndpointHealthRecord[],
): EndpointHealthRecord[] {
  return [...records].sort((a, b) =>
    a.lastUsedIso < b.lastUsedIso ? 1 : a.lastUsedIso > b.lastUsedIso ? -1 : 0,
  );
}

export function useModelHealth(): UseModelHealthResult {
  const [records, setRecords] = useState<EndpointHealthRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  // guards a poll tick landing after unmount from calling setState on a gone component.
  const alive = useRef(true);

  const load = useCallback(async () => {
    const res = await window.prometheus?.modelHealth?.list();
    if (!alive.current) return;
    if (!res || !res.ok || !res.store) {
      setError(res?.error ?? "model health IPC unavailable");
      setLoading(false);
      return;
    }
    setError(undefined);
    setRecords(sortByLastUsedDesc(Object.values(res.store)));
    setLoading(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { records, loading, error, refresh };
}

export default useModelHealth;
