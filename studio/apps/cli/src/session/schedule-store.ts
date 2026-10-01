// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/schedule-store.ts — the ONE global on-disk record of every scheduled/autonomous
 * task, as registered by `prometheus tasks` (or the desktop's mirror of it).
 *
 * Like model-health-store.ts (this file's sibling and model) and UNLIKE path-frecency-store.ts,
 * schedules are NOT per-project: there is a single store for the whole Prometheus install,
 * keyed by `task.id`. The merge/remove logic lives in @prometheus/core's agent/schedule —
 * this file is only the on-disk I/O, mirroring model-health-store.ts's fail-soft,
 * injected-fs conventions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { agent } from "@prometheus/core";

type ScheduledTask = agent.ScheduledTask;
type ScheduleStore = agent.ScheduleStore;

import { prometheusHome } from "../home.js";

/** The fs surface this store needs (injected in tests). */
export interface ScheduleFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string) => void;
}

const defaultFs: ScheduleFs = {
  existsSync,
  readFileSync: (p) => readFileSync(p, "utf8"),
  writeFileSync: (p, data) => writeFileSync(p, data),
  mkdirSync: (p) => mkdirSync(p, { recursive: true }),
};

function storeFile(home: string): string {
  return join(home, "state", "schedules.json");
}

/** Load the global schedule store (fail-soft → {}; never throws). */
export function loadSchedules(
  home: string = prometheusHome(),
  fs: ScheduleFs = defaultFs,
): ScheduleStore {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(home))) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ScheduleStore) : {};
  } catch {
    return {};
  }
}

/** Persist the global schedule store. Never throws — a failed write costs one lost
 *  update, not a crash mid-session. */
export function saveSchedules(
  store: ScheduleStore,
  home: string = prometheusHome(),
  fs: ScheduleFs = defaultFs,
): void {
  try {
    fs.mkdirSync(dirname(storeFile(home)));
    fs.writeFileSync(storeFile(home), `${JSON.stringify(store, null, 2)}\n`);
  } catch {
    /* best-effort — a lost write is not worth surfacing to the user. */
  }
}

/** Merge one task into the store, persisting + returning the resulting store. */
export function upsertTask(
  task: ScheduledTask,
  home: string = prometheusHome(),
  fs: ScheduleFs = defaultFs,
): ScheduleStore {
  const next = agent.mergeTask(loadSchedules(home, fs), task);
  saveSchedules(next, home, fs);
  return next;
}

/** Remove one task by id, persisting + returning the resulting store. A no-op (not an
 *  error) when the id is already gone. */
export function removeScheduledTask(
  id: string,
  home: string = prometheusHome(),
  fs: ScheduleFs = defaultFs,
): ScheduleStore {
  const next = agent.removeTask(loadSchedules(home, fs), id);
  saveSchedules(next, home, fs);
  return next;
}
