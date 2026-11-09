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
import { readFile } from "node:fs/promises";
import { agent } from "@prometheus/core";

import { readLayer, writeLayerAtomic } from "./settings-store.js";

/** Local aliases for readability — schedule.ts's types live under the `agent` namespace. */
type ScheduledTask = agent.ScheduledTask;
type ScheduleStore = agent.ScheduleStore;

/** Load the whole store from disk; a missing/corrupt file is an empty store (fail-soft). */
export async function loadSchedules(globalPath: string): Promise<ScheduleStore> {
  return (await readLayer(globalPath)) as unknown as ScheduleStore;
}

/**
 * Load for a WRITE: a missing file is an empty store, but a file that exists and does not parse
 * THROWS. The fail-soft read above is right for display and wrong for read-modify-write — a
 * hand-edited or half-written schedules.json read as `{}`, and the next upsert replaced every
 * task with one. Refusing keeps the user's file for them to fix.
 */
export async function loadSchedulesForWrite(globalPath: string): Promise<ScheduleStore> {
  let raw: string;
  try {
    raw = await readFile(globalPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw); // throws on a corrupt file — the write is refused
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${globalPath} is not a schedules object — not overwritten`);
  }
  return parsed as ScheduleStore;
}

/** One write at a time per file: unserialized load→merge→save lost concurrent updates. */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(path: string, op: () => Promise<T>): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve();
  const next = prev.then(op, op);
  queues.set(
    path,
    next.catch(() => undefined),
  );
  return next;
}

/** Persist the whole store atomically. */
export async function saveSchedules(globalPath: string, store: ScheduleStore): Promise<void> {
  await writeLayerAtomic(globalPath, store as unknown as Record<string, unknown>);
}

/** Load, merge in one task (keyed by `id`), save, and return the new store. */
export async function upsertTask(globalPath: string, task: ScheduledTask): Promise<ScheduleStore> {
  return serialized(globalPath, async () => {
    const store = await loadSchedulesForWrite(globalPath);
    const merged = agent.mergeTask(store, task);
    await saveSchedules(globalPath, merged);
    return merged;
  });
}

/** Load, remove one task by id (a no-op if already gone), save, and return the new store. */
export async function removeScheduledTask(globalPath: string, id: string): Promise<ScheduleStore> {
  return serialized(globalPath, async () => {
    const store = await loadSchedulesForWrite(globalPath);
    const next = agent.removeTask(store, id);
    await saveSchedules(globalPath, next);
    return next;
  });
}
