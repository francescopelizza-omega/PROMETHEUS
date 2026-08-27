/**
 * schedule-ipc.test.ts — node:test coverage for registerScheduleIpcHandlers():
 * `scheduleList` returns the (possibly empty) on-disk store, `scheduleUpsert` persists a
 * valid-shaped `ScheduledTask` and rejects a malformed one before it ever reaches disk,
 * `scheduleRemove` removes a real id and no-ops on an unknown one (mirrors core's
 * `removeTask` contract — see schedule-store.test.ts), and a full dispose lets
 * re-registration succeed (mirrors model-health-ipc.test.ts's Task #10-style pattern).
 *
 * schedule-ipc.ts does a REAL top-level `import { ipcMain } from "electron"`, so this suite
 * uses node:test's `mock.module()` (wired into scripts/run-tests.mjs) to substitute a fake
 * exposing just `ipcMain`, then calls the registered handlers DIRECTLY (bypassing real IPC
 * transport) to exercise the actual handler bodies against a real tmpdir JSON file.
 *
 * `mock.module("electron", ...)` may only be called ONCE per process (a second call throws
 * "already mocked"), so — mirroring model-health-ipc.test.ts, NOT ide-ipc.test.ts's per-test
 * call — the mock + the ONE resulting module import + registration happen ONCE at file scope,
 * closing over a single tmp `globalPath` all tests share. Tests therefore run in declaration
 * order (node:test's default here, no `concurrency`) and are written to build on that shared,
 * accumulating state; the register→dispose→register test is placed LAST since it leaves the
 * registry re-registered afterward and nothing later depends on it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import {
  IPC,
  type ScheduleListResult,
  type ScheduleRemoveResult,
  type ScheduleUpsertResult,
} from "../shared/ipc-contract.js";

type Handler = (event: unknown, arg: unknown) => unknown;

function makeFakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handle(channel: string, fn: Handler): void {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`);
      }
      handlers.set(channel, fn);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    handledChannels(): Set<string> {
      return new Set(handlers.keys());
    },
    invoke(channel: string, arg: unknown): unknown {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler registered for '${channel}'`);
      return fn(undefined, arg);
    },
  };
}

const tmpDir = await mkdtemp(join(tmpdir(), "prom-schedule-ipc-"));
const globalPath = join(tmpDir, "schedules.json");

const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", { exports: { ipcMain: fakeIpcMain } });
const { registerScheduleIpcHandlers } = await import("./schedule-ipc.js");
registerScheduleIpcHandlers(globalPath);

const validTask = {
  id: "task-1",
  name: "Summarize today's commits",
  cronExpr: "0 9 * * *",
  task: "Summarize today's commits in this repo.",
  cwd: "/repo",
  autonomy: "readonly" as const,
  enabled: true,
  createdIso: "2026-08-18T00:00:00.000Z",
};

test("scheduleList: returns an empty store before anything has ever been scheduled", async () => {
  const res = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.equal(res.ok, true);
  assert.deepEqual(res.store, {});
});

test("scheduleUpsert: rejects a missing id and never reaches the store", async () => {
  const { id: _drop, ...withoutId } = validTask;
  const res = (await fakeIpcMain.invoke(IPC.scheduleUpsert, withoutId)) as ScheduleUpsertResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /id/);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.deepEqual(list.store, {}, "a rejected task must never be written to disk");
});

test("scheduleUpsert: rejects a missing name and never reaches the store", async () => {
  const { name: _drop, ...withoutName } = validTask;
  const res = (await fakeIpcMain.invoke(IPC.scheduleUpsert, withoutName)) as ScheduleUpsertResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /name/);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.deepEqual(list.store, {}, "a rejected task must never be written to disk");
});

test("scheduleUpsert: rejects a missing cronExpr and never reaches the store", async () => {
  const { cronExpr: _drop, ...withoutCronExpr } = validTask;
  const res = (await fakeIpcMain.invoke(
    IPC.scheduleUpsert,
    withoutCronExpr,
  )) as ScheduleUpsertResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /cronExpr/);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.deepEqual(list.store, {}, "a rejected task must never be written to disk");
});

test("scheduleUpsert: rejects a missing task and never reaches the store", async () => {
  const { task: _drop, ...withoutTask } = validTask;
  const res = (await fakeIpcMain.invoke(IPC.scheduleUpsert, withoutTask)) as ScheduleUpsertResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /task/);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.deepEqual(list.store, {}, "a rejected task must never be written to disk");
});

test("scheduleUpsert: rejects an invalid autonomy value and never reaches the store", async () => {
  const invalidAutonomy = { ...validTask, autonomy: "sudo" };
  const res = (await fakeIpcMain.invoke(
    IPC.scheduleUpsert,
    invalidAutonomy,
  )) as ScheduleUpsertResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /autonomy/);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.deepEqual(list.store, {}, "a rejected task must never be written to disk");
});

test("scheduleUpsert: rejects a syntactically-invalid cronExpr and never reaches the store", async () => {
  const invalidCron = { ...validTask, cronExpr: "not a cron" };
  const res = (await fakeIpcMain.invoke(IPC.scheduleUpsert, invalidCron)) as ScheduleUpsertResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /cronExpr/);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.deepEqual(list.store, {}, "a rejected task must never be written to disk");
});

test("scheduleUpsert: rejects a non-object arg (e.g. null/undefined) defensively", async () => {
  const res = (await fakeIpcMain.invoke(IPC.scheduleUpsert, null)) as ScheduleUpsertResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /id/);
});

test("scheduleUpsert: persists a valid-shaped task, and a follow-up list reflects it", async () => {
  const res = (await fakeIpcMain.invoke(IPC.scheduleUpsert, validTask)) as ScheduleUpsertResult;
  assert.equal(res.ok, true);
  assert.equal(res.error, undefined);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.equal(list.ok, true);
  assert.deepEqual(list.store?.["task-1"], validTask);
  assert.equal(Object.keys(list.store ?? {}).length, 1);
});

test("scheduleUpsert: a second task under a different id adds to, not replaces, the store", async () => {
  const second = {
    ...validTask,
    id: "task-2",
    name: "Triage new issues",
    cronExpr: "*/30 * * * *",
    autonomy: "edits" as const,
  };
  const res = (await fakeIpcMain.invoke(IPC.scheduleUpsert, second)) as ScheduleUpsertResult;
  assert.equal(res.ok, true);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.deepEqual(Object.keys(list.store ?? {}).sort(), ["task-1", "task-2"]);
  assert.deepEqual(list.store?.["task-2"], second);
  assert.deepEqual(list.store?.["task-1"], validTask, "the earlier task must be untouched");
});

test("scheduleUpsert: re-upserting an existing id overwrites that entry (merge-by-id)", async () => {
  const updated = {
    ...validTask,
    enabled: false,
    lastRunIso: "2026-08-19T09:00:00.000Z",
    lastResult: {
      ok: true,
      summary: "No new commits today.",
      ranIso: "2026-08-19T09:00:00.000Z",
      toolCalls: [] as string[],
    },
  };
  const res = (await fakeIpcMain.invoke(IPC.scheduleUpsert, updated)) as ScheduleUpsertResult;
  assert.equal(res.ok, true);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.equal(Object.keys(list.store ?? {}).length, 2, "still 2 tasks, not 3");
  assert.deepEqual(list.store?.["task-1"], updated);
});

test("scheduleRemove: rejects a missing id and leaves the store untouched", async () => {
  const res = (await fakeIpcMain.invoke(IPC.scheduleRemove, {})) as ScheduleRemoveResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /id/);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.equal(Object.keys(list.store ?? {}).length, 2, "nothing removed by a rejected arg");
});

test("scheduleRemove: removing an unknown id is a no-op, not an error (mirrors core's removeTask)", async () => {
  const res = (await fakeIpcMain.invoke(IPC.scheduleRemove, {
    id: "does-not-exist",
  })) as ScheduleRemoveResult;
  assert.equal(res.ok, true);
  assert.equal(res.error, undefined);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.equal(Object.keys(list.store ?? {}).length, 2, "no task should have been removed");
});

test("scheduleRemove: removes the right task and leaves the other", async () => {
  const res = (await fakeIpcMain.invoke(IPC.scheduleRemove, {
    id: "task-2",
  })) as ScheduleRemoveResult;
  assert.equal(res.ok, true);
  assert.equal(res.error, undefined);

  const list = (await fakeIpcMain.invoke(IPC.scheduleList, {})) as ScheduleListResult;
  assert.deepEqual(Object.keys(list.store ?? {}), ["task-1"]);
});

test("registerScheduleIpcHandlers: a full dispose lets re-registration succeed (window-reload safety)", () => {
  assert.deepEqual(
    [...fakeIpcMain.handledChannels()].sort(),
    [IPC.scheduleList, IPC.scheduleUpsert, IPC.scheduleRemove].sort(),
  );
  for (const channel of [IPC.scheduleList, IPC.scheduleUpsert, IPC.scheduleRemove]) {
    fakeIpcMain.removeHandler(channel);
  }
  assert.equal(fakeIpcMain.handledChannels().size, 0);

  assert.doesNotThrow(() => {
    registerScheduleIpcHandlers(globalPath);
  }, "re-registering after a full dispose must not throw double-registration");
  assert.deepEqual(
    [...fakeIpcMain.handledChannels()].sort(),
    [IPC.scheduleList, IPC.scheduleUpsert, IPC.scheduleRemove].sort(),
  );
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
