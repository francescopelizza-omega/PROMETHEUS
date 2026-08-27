/**
 * renderer/shared/budget/useBudgetStatus.ts — Settings ▸ Budget & Spend's data hook.
 *
 * Budget is GLOBAL (one spend cap per install, not per-workspace — mirrors
 * `useModelHealth.ts`'s own reasoning), so this polls `window.prometheus.budget.status()` on an
 * interval, not just on mount: a user who leaves the page open while a metered turn runs
 * elsewhere should watch the spend number move, not have to navigate away and back.
 *
 * Renderer-SANDBOXED (C5): react + `window.prometheus.budget`/`window.prometheus.settings` only.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 4000;

export interface BudgetConfigView {
  sessionUsd?: number;
  dailyUsd?: number;
  warnAtPercent?: number;
  unpricedPolicy?: "block" | "warn";
}

export interface BudgetStatusView {
  capped: boolean;
  config: BudgetConfigView;
  sessionSpentUsd: number;
  dailySpentUsd: number;
  unpriced: string[];
}

const EMPTY_STATUS: BudgetStatusView = {
  capped: false,
  config: {},
  sessionSpentUsd: 0,
  dailySpentUsd: 0,
  unpriced: [],
};

export interface UseBudgetStatusResult {
  status: BudgetStatusView;
  loading: boolean;
  error: string | undefined;
  /** Re-fetch immediately, without waiting for the next poll tick. */
  refresh: () => void;
  /** Set one budget config key via the existing generic settings tree, then refresh. */
  setBudgetField: (
    key: "budget.sessionUsd" | "budget.dailyUsd" | "budget.warnAtPercent" | "budget.unpricedPolicy",
    value: number | "block" | "warn",
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function useBudgetStatus(): UseBudgetStatusResult {
  const [status, setStatus] = useState<BudgetStatusView>(EMPTY_STATUS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  // guards a poll tick landing after unmount from calling setState on a gone component.
  const alive = useRef(true);

  const load = useCallback(async () => {
    const res = await window.prometheus?.budget?.status();
    if (!alive.current) return;
    if (!res || !res.ok) {
      setError(res?.error ?? "budget IPC unavailable");
      setLoading(false);
      return;
    }
    setError(undefined);
    setStatus({
      capped: res.capped ?? false,
      config: res.config ?? {},
      sessionSpentUsd: res.sessionSpentUsd ?? 0,
      dailySpentUsd: res.dailySpentUsd ?? 0,
      unpriced: res.unpriced ?? [],
    });
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

  const setBudgetField = useCallback(
    async (
      key:
        | "budget.sessionUsd"
        | "budget.dailyUsd"
        | "budget.warnAtPercent"
        | "budget.unpricedPolicy",
      value: number | "block" | "warn",
    ): Promise<{ ok: boolean; error?: string }> => {
      const res = await window.prometheus?.settings?.set(key, value, "global");
      if (!res || !res.ok) return { ok: false, error: res?.error ?? "settings IPC unavailable" };
      await load();
      return { ok: true };
    },
    [load],
  );

  return { status, loading, error, refresh, setBudgetField };
}

export default useBudgetStatus;
