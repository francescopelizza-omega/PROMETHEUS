/**
 * schedule-store.test.ts — the atomic on-disk ScheduleStore persistence behind
 * Scheduled/Autonomous Runs (desktop main). Real tmpdir fs, no Electron.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { agent } from "@prometheus/core";

import { loadSchedules, removeScheduledTask, saveSchedules, upsertTask } from "./schedule-store.js";

type ScheduledTask = agent.ScheduledTask;

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-schedule-store-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Summarize today's commits",
    cronExpr: "0 9 * * *",
    task: "Summarize today's commits in this repo.",
    autonomy: "readonly",
    enabled: true,
    createdIso: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

test("loadSchedules: missing file → empty store (fail-soft, never throws)", async () => {
  await withTmpDir(async (dir) => {
    const store = await loadSchedules(join(dir, "schedules.json"));
    assert.deepEqual(store, {});
  });
});

test("saveSchedules + loadSchedules: round-trips a store, creates missing parent dirs", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "nested", "deep", "schedules.json");
    const task = makeTask();
    await saveSchedules(path, { [task.id]: task });
    const loaded = await loadSchedules(path);
    assert.deepEqual(loaded, { [task.id]: task });
  });
});

test("upsertTask: merges a fresh task into a missing store", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "schedules.json");
    const task = makeTask();
    const store = await upsertTask(path, task);
    assert.deepEqual(store, { [task.id]: task });
    // persisted, not just returned in-memory
    const reloaded = await loadSchedules(path);
    assert.deepEqual(reloaded, { [task.id]: task });
  });
});

test("upsertTask: merging two distinct tasks loses neither", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "schedules.json");
    const first = makeTask({ id: "task-1", name: "Summarize commits" });
    const second = makeTask({
      id: "task-2",
      name: "Triage new issues",
      cronExpr: "*/30 * * * *",
      autonomy: "edits",
      cwd: "/repo/second",
    });

    await upsertTask(path, first);
    const store = await upsertTask(path, second);

    assert.deepEqual(store, { "task-1": first, "task-2": second });
    const reloaded = await loadSchedules(path);
    assert.deepEqual(reloaded, { "task-1": first, "task-2": second });
  });
});

test("upsertTask: re-upserting the same id overwrites only that entry", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "schedules.json");
    const first = makeTask({ id: "task-1", enabled: true });
    const other = makeTask({ id: "task-2", name: "Update the changelog" });
    const updated = makeTask({
      id: "task-1",
      enabled: false,
      lastRunIso: "2026-08-19T09:00:00.000Z",
      lastResult: {
        ok: true,
        summary: "No new commits today.",
        ranIso: "2026-08-19T09:00:00.000Z",
        toolCalls: ["run_command"],
      },
    });

    await upsertTask(path, first);
    await upsertTask(path, other);
    const store = await upsertTask(path, updated);

    assert.deepEqual(store["task-1"], updated);
    assert.deepEqual(store["task-2"], other);
  });
});

test("removeScheduledTask: removes the right task and leaves others", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "schedules.json");
    const first = makeTask({ id: "task-1" });
    const second = makeTask({ id: "task-2", name: "Triage new issues" });

    await upsertTask(path, first);
    await upsertTask(path, second);
    const store = await removeScheduledTask(path, "task-1");

    assert.deepEqual(store, { "task-2": second });
    const reloaded = await loadSchedules(path);
    assert.deepEqual(reloaded, { "task-2": second });
  });
});

test("removeScheduledTask: removing an id that is already gone is a no-op", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "schedules.json");
    const task = makeTask();
    await upsertTask(path, task);

    const store = await removeScheduledTask(path, "does-not-exist");

    assert.deepEqual(store, { [task.id]: task });
    const reloaded = await loadSchedules(path);
    assert.deepEqual(reloaded, { [task.id]: task });
  });
});
