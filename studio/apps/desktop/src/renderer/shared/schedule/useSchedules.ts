/**
 * renderer/shared/schedule/useSchedules.ts — Settings ▸ Scheduled Tasks' data hook.
 *
 * Scheduled tasks are GLOBAL, not per-workspace — like Model Health (see that hook's own doc
 * comment) a scheduled/autonomous run isn't tied to one open project, so unlike HooksPage's
 * `reload` this takes no `workspaceRoot` and polls `window.prometheus.schedule.list()` on an
 * interval (not just on mount) — a user who leaves the page open should see a task's
 * `lastResult` update the moment the runner finishes it, not have to navigate away and back.
 *
 * Renderer-SANDBOXED (C5): react + the pure `agent.ScheduleAutonomy`/`agent.ScheduleRunResult`
 * TYPES from `@prometheus/core` (type-only import — fully erased, no runtime footprint) +
 * `globalThis.window?.prometheus?.schedule` only. Per this feature's own safety note: a bare
 * `window.prometheus...` reference throws ReferenceError under node:test (no DOM, no global
 * `window` at all) — every access here goes through `globalThis.window?.` first.
 */
import type * as agent from "@prometheus/core/agent-schedule";
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 5000;

/**
 * The renderer-facing mirror of one scheduled task, as carried across the schedule IPC bridge
 * (`window.prometheus.schedule.*`). Same shape as core's `agent.ScheduledTask` (see that
 * module's own header for the field-by-field contract) — its `autonomy` and `lastResult` types
 * are reused directly from core rather than re-declared, so the ladder/result shape can never
 * drift between the two.
 */
export interface ScheduledTaskView {
  id: string;
  name: string;
  cronExpr: string;
  task: string;
  cwd?: string;
  autonomy: agent.ScheduleAutonomy;
  enabled: boolean;
  createdIso: string;
  lastRunIso?: string;
  lastResult?: agent.ScheduleRunResult;
}

export interface UseSchedulesResult {
  tasks: ScheduledTaskView[];
  loading: boolean;
  error: string | undefined;
  /** Re-fetch immediately, without waiting for the next poll tick. */
  refresh: () => void;
  /** Create or replace one task (keyed by id), then refresh immediately. Resolves `true` on
   *  success; on failure it leaves `error` set and resolves `false` (the caller decides
   *  whether/how to keep the user's in-progress form). */
  upsert: (task: ScheduledTaskView) => Promise<boolean>;
  /** Remove one task by id, then refresh immediately. Same success/failure contract as `upsert`. */
  remove: (id: string) => Promise<boolean>;
}

/** Alphabetical by name — a stable, predictable order for a list a user names and edits by
 *  hand (unlike Model Health's most-recently-used order, there's no "recency" here that
 *  matters more than just finding the task you gave a name). Pure + exported for reuse/tests. */
export function sortByName(tasks: readonly ScheduledTaskView[]): ScheduledTaskView[] {
  return [...tasks].sort((a, b) => a.name.localeCompare(b.name));
}

export function useSchedules(): UseSchedulesResult {
  const [tasks, setTasks] = useState<ScheduledTaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  // guards a poll tick landing after unmount from calling setState on a gone component.
  const alive = useRef(true);

  const load = useCallback(async () => {
    const res = await globalThis.window?.prometheus?.schedule?.list();
    if (!alive.current) return;
    if (!res || !res.ok || !res.store) {
      setError(res?.error ?? "schedule IPC unavailable");
      setLoading(false);
      return;
    }
    setError(undefined);
    setTasks(sortByName(Object.values(res.store)));
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

  const upsert = useCallback(
    async (task: ScheduledTaskView): Promise<boolean> => {
      const res = await globalThis.window?.prometheus?.schedule?.upsert(task);
      if (!res?.ok) {
        setError(res?.error ?? "save failed");
        return false;
      }
      setError(undefined);
      void load();
      return true;
    },
    [load],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      const res = await globalThis.window?.prometheus?.schedule?.remove(id);
      if (!res?.ok) {
        setError(res?.error ?? "remove failed");
        return false;
      }
      setError(undefined);
      void load();
      return true;
    },
    [load],
  );

  return { tasks, loading, error, refresh, upsert, remove };
}

export default useSchedules;
