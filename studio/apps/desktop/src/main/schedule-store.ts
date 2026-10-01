// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/schedule-store.ts — pure(ish) disk persistence for `ScheduleStore` (Scheduled/
 * Autonomous Runs). Split out exactly like model-health-store.ts (which is itself split out
 * like settings-store.ts) so this stays unit-testable: node:fs/promises + @prometheus/core
 * only, no Electron.
 *
 * Like model health, schedules have only ONE layer — a scheduled task is a whole-install
 * concept, not workspace-scoped — so this is a thin read/merge/write on top of
 * settings-store's fail-soft `readLayer` / atomic `writeLayerAtomic`, reused directly rather
 * than reimplementing file I/O. The caller resolves the absolute path (this repo's
 * convention is `${app.getPath("userData")}/schedules.json`); this module never touches
 * Electron's `app` module, keeping it as pure/testable as settings-store.ts.
 *
 * The merge/remove logic itself lives in @prometheus/core's `agent/schedule` (namespaced
 * under `agent`, unlike model-health's flat exports — confirmed against
 * packages/core/src/index.ts and packages/core/src/agent/index.ts) — this file is only the
 * on-disk I/O.
 */
import { agent } from "@prometheus/core";

import { readLayer, writeLayerAtomic } from "./settings-store.js";

/** Local aliases for readability — schedule.ts's types live under the `agent` namespace. */
type ScheduledTask = agent.ScheduledTask;
type ScheduleStore = agent.ScheduleStore;

/** Load the whole store from disk; a missing/corrupt file is an empty store (fail-soft). */
export async function loadSchedules(globalPath: string): Promise<ScheduleStore> {
  return (await readLayer(globalPath)) as unknown as ScheduleStore;
}

/** Persist the whole store atomically. */
export async function saveSchedules(globalPath: string, store: ScheduleStore): Promise<void> {
  await writeLayerAtomic(globalPath, store as unknown as Record<string, unknown>);
}

/** Load, merge in one task (keyed by `id`), save, and return the new store. */
export async function upsertTask(globalPath: string, task: ScheduledTask): Promise<ScheduleStore> {
  const store = await loadSchedules(globalPath);
  const merged = agent.mergeTask(store, task);
  await saveSchedules(globalPath, merged);
  return merged;
}

/** Load, remove one task by id (a no-op if already gone), save, and return the new store. */
export async function removeScheduledTask(globalPath: string, id: string): Promise<ScheduleStore> {
  const store = await loadSchedules(globalPath);
  const next = agent.removeTask(store, id);
  await saveSchedules(globalPath, next);
  return next;
}
