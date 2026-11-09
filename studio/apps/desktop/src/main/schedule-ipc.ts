import { isAbsolute } from "node:path";
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
import { describeEngineFailure } from "@prometheus/engine-bridge";
import { ipcMain } from "electron";

import {
  IPC,
  type ScheduleListResult,
  type ScheduleRemoveResult,
  type ScheduleUpsertResult,
} from "../shared/ipc-contract.js";
import {
  loadSchedules,
  loadSchedulesForWrite,
  removeScheduledTask,
  upsertTask,
} from "./schedule-store.js";

type ScheduledTask = coreAgent.ScheduledTask;

const VALID_AUTONOMY = new Set(["readonly", "edits", "commands"]);

// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

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
  if (a.id.length > 128 || a.name.length > 200 || a.task.length > 8000) {
    return { error: "id, name or task is too long" };
  }
  if (
    a.cwd !== undefined &&
    (typeof a.cwd !== "string" || !isAbsolute(a.cwd) || a.cwd.length > 4096)
  ) {
    return { error: "cwd must be an absolute path" };
  }
  // REBUILT from the known fields, never `arg as ScheduledTask`: run history (`lastRunIso`,
  // `lastResult`) and the creation stamp are main's to keep, and nothing else rides along.
  return {
    task: {
      id: a.id,
      name: a.name,
      cronExpr: a.cronExpr,
      task: a.task,
      ...(typeof a.cwd === "string" ? { cwd: a.cwd } : {}),
      autonomy: a.autonomy as ScheduledTask["autonomy"],
      enabled: a.enabled !== false,
      createdIso:
        typeof a.createdIso === "string" && !Number.isNaN(Date.parse(a.createdIso))
          ? a.createdIso
          : new Date().toISOString(),
    },
  };
}

/**
 * Does saving `next` need the human's native OK? A task that may edit files or run commands
 * executes later, UNATTENDED, from the user's cron — so creating one, or changing what it does,
 * where, how often or how much it may do, is confirmed in main. The renderer's form is not the
 * consent: any renderer could post this IPC.
 */
export function scheduleNeedsConsent(
  prev: ScheduledTask | undefined,
  next: ScheduledTask,
): boolean {
  if (next.autonomy === "readonly") return false;
  if (!next.enabled) return false;
  if (!prev) return true;
  return (
    prev.task !== next.task ||
    prev.cwd !== next.cwd ||
    prev.cronExpr !== next.cronExpr ||
    prev.autonomy !== next.autonomy ||
    !prev.enabled
  );
}

async function nativeConfirmSchedule(t: ScheduledTask): Promise<boolean> {
  try {
    const electron = (await import("electron")) as unknown as {
      dialog?: { showMessageBox: (o: unknown) => Promise<{ response: number }> };
    };
    if (!electron.dialog) return false;
    const r = await electron.dialog.showMessageBox({
      type: "warning",
      buttons: ["Cancel", "Schedule it"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: `Let "${t.name.slice(0, 80)}" run unattended with ${t.autonomy} autonomy?`,
      detail:
        `When: ${t.cronExpr}\nWhere: ${t.cwd ?? "(the scheduler's directory)"}\n\n` +
        `${t.task.slice(0, 1200)}\n\nIt will run from your cron, with nobody watching.`,
    });
    return r.response === 1;
  } catch {
    return false;
  }
}

/** Register the `schedule:*` handlers. Returns a disposer (mirrors sibling IPC modules). */
export function registerScheduleIpcHandlers(
  globalPath: string,
  opts: { confirm?: (task: ScheduledTask) => Promise<boolean> } = {},
): () => void {
  const confirm = opts.confirm ?? nativeConfirmSchedule;
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
      const prev = (await loadSchedulesForWrite(globalPath))[validated.task.id];
      const next: ScheduledTask = {
        ...validated.task,
        // history and birth date are the store's, not the caller's
        ...(prev?.createdIso ? { createdIso: prev.createdIso } : {}),
        ...(prev?.lastRunIso ? { lastRunIso: prev.lastRunIso } : {}),
        ...(prev?.lastResult ? { lastResult: prev.lastResult } : {}),
      };
      if (scheduleNeedsConsent(prev, next) && !(await confirm(next))) {
        return { ok: false, error: "not scheduled — you did not confirm it" };
      }
      await upsertTask(globalPath, next);
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
