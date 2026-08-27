/**
 * main/schedule-ipc.ts — the `schedule:*` ipcMain handlers for the Scheduled/Autonomous Runs
 * feature (RELAY-ONLY, mirrors model-health-ipc.ts): lists the on-disk `ScheduleStore` for the
 * desktop Settings panel to render, and persists a create/update ("upsert") or delete of one
 * `ScheduledTask` via schedule-store.ts's fail-soft read/merge/write.
 *
 * Like model-health (and unlike path-completion, which takes a renderer-supplied
 * `dir`/`workspaceRoot`), the store path here is a single MAIN-process-owned constant
 * (`<userData>/schedules.json`, resolved by the caller and passed in as `globalPath`) — there is
 * no path in the arg at all, so there is nothing for a compromised/buggy renderer to redirect.
 *
 * `ScheduledTask`'s shape (id/name/cronExpr/task/autonomy/enabled/createdIso/...) lives in
 * @prometheus/core's `agent/schedule` module, namespaced under `agent` (unlike model-health's
 * flat exports) — see schedule-store.ts's header for the same note. `scheduleUpsert` defensively
 * narrows the renderer-supplied arg before it ever reaches schedule-store.ts, mirroring
 * model-health-ipc.ts's arg-narrowing for `modelHealthRecord`: a rejected arg is never persisted.
 * `scheduleRemove` mirrors core's `removeTask` no-op-on-unknown-id contract (see
 * schedule-store.test.ts) — removing an id that doesn't exist is not an error.
 */
import { agent as coreAgent } from "@prometheus/core";
import { ipcMain } from "electron";

import {
  IPC,
  type ScheduleListResult,
  type ScheduleRemoveResult,
  type ScheduleUpsertResult,
} from "../shared/ipc-contract.js";
import { loadSchedules, removeScheduledTask, upsertTask } from "./schedule-store.js";

type ScheduledTask = coreAgent.ScheduledTask;

const VALID_AUTONOMY = new Set(["readonly", "edits", "commands"]);

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Defensively narrow `arg` into a plausible `ScheduledTask`, or explain what's wrong. Only the
 *  fields load-bearing for identifying/scheduling/authorizing the task are checked here —
 *  everything else on the object (cwd, enabled, createdIso, lastRunIso, lastResult, ...) passes
 *  through untouched, exactly as model-health-ipc.ts does for `EndpointHealthRecord`. `cronExpr`
 *  is re-validated with the SAME `agent.validateCronExpr` the CLI's `add` refuses on — belt and
 *  suspenders against a caller that bypasses the (already-validating) renderer form, even though
 *  an invalid cron already fails closed (never fires) at the `isDue`/`cronMatches` layer. */
function validateScheduledTask(arg: unknown): { task: ScheduledTask } | { error: string } {
  const a = (arg ?? {}) as Record<string, unknown>;
  if (typeof a.id !== "string" || a.id.length === 0) {
    return { error: "id is required" };
  }
  if (typeof a.name !== "string" || a.name.length === 0) {
    return { error: "name is required" };
  }
  if (typeof a.cronExpr !== "string" || a.cronExpr.length === 0) {
    return { error: "cronExpr is required" };
  }
  const cronError = coreAgent.validateCronExpr(a.cronExpr);
  if (cronError) {
    return { error: `invalid cronExpr: ${cronError}` };
  }
  if (typeof a.task !== "string" || a.task.length === 0) {
    return { error: "task is required" };
  }
  if (typeof a.autonomy !== "string" || !VALID_AUTONOMY.has(a.autonomy)) {
    return { error: 'autonomy must be one of "readonly", "edits", or "commands"' };
  }
  return { task: arg as ScheduledTask };
}

/** Register the `schedule:*` handlers. Returns a disposer (mirrors sibling IPC modules). */
export function registerScheduleIpcHandlers(globalPath: string): () => void {
  ipcMain.handle(IPC.scheduleList, async (_e): Promise<ScheduleListResult> => {
    try {
      return { ok: true, store: await loadSchedules(globalPath) };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.scheduleUpsert, async (_e, arg: unknown): Promise<ScheduleUpsertResult> => {
    const validated = validateScheduledTask(arg);
    if ("error" in validated) {
      return { ok: false, error: validated.error };
    }
    try {
      await upsertTask(globalPath, validated.task);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.scheduleRemove, async (_e, arg: unknown): Promise<ScheduleRemoveResult> => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const id = typeof a.id === "string" && a.id.length > 0 ? a.id : undefined;
    if (!id) {
      return { ok: false, error: "id is required" };
    }
    try {
      await removeScheduledTask(globalPath, id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  return () => {
    for (const channel of [IPC.scheduleList, IPC.scheduleUpsert, IPC.scheduleRemove]) {
      ipcMain.removeHandler(channel);
    }
  };
}
