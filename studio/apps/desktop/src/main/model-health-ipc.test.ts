/**
 * model-health-ipc.test.ts — node:test coverage for registerModelHealthIpcHandlers():
 * `modelHealthList` returns the (possibly empty) on-disk store, `modelHealthRecord`
 * persists a valid-shaped record and rejects a malformed one before it ever reaches
 * disk, and a full dispose lets re-registration succeed (mirrors
 * path-completion-ipc.test.ts's Task #10-style pattern).
 *
 * model-health-ipc.ts does a REAL top-level `import { ipcMain } from "electron"`, so
 * this suite uses node:test's `mock.module()` (wired into scripts/run-tests.mjs) to
 * substitute a fake exposing just `ipcMain`, then calls the registered handlers
 * DIRECTLY (bypassing real IPC transport) to exercise the actual handler bodies
 * against a real tmpdir JSON file.
 *
 * `mock.module("electron", ...)` may only be called ONCE per process (a second call
 * throws "already mocked"), so — mirroring path-completion-ipc.test.ts, NOT
 * ide-ipc.test.ts's per-test call — the mock + the ONE resulting module import +
 * registration happen ONCE at file scope, closing over a single tmp `globalPath` all
 * tests share. Tests therefore run in declaration order (node:test's default here,
 * no `concurrency`) and are written to build on that shared, accumulating state; the
 * register→dispose→register test is placed LAST since it leaves the registry
 * re-registered afterward and nothing later depends on it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import {
  IPC,
  type ModelHealthListResult,
  type ModelHealthRecordResult,
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

const tmpDir = await mkdtemp(join(tmpdir(), "prom-model-health-ipc-"));
const globalPath = join(tmpDir, "model-health.json");

const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", { exports: { ipcMain: fakeIpcMain } });
const { registerModelHealthIpcHandlers } = await import("./model-health-ipc.js");
registerModelHealthIpcHandlers(globalPath);

const validRecord = {
  endpointId: "ep-1",
  model: "gpt-4o",
  locality: "cloud" as const,
  transport: "native" as const,
  demonstrated: true,
  nativeCalls: 5,
  textCallsWhileNative: 0,
  textSyntaxCalls: 0,
  nativeRejected: false,
  breakerState: "closed" as const,
  breakerFailures: 0,
  breakerOpenedAt: null,
  contextWindow: 128_000,
  contextWindowSource: "openai-models" as const,
  lastUsedIso: "2026-08-18T12:00:00.000Z",
};

test("modelHealthList: returns an empty store before anything has ever been recorded", async () => {
  const res = (await fakeIpcMain.invoke(IPC.modelHealthList, {})) as ModelHealthListResult;
  assert.equal(res.ok, true);
  assert.deepEqual(res.store, {});
});

test("modelHealthRecord: rejects a missing endpointId and never reaches the store", async () => {
  const { endpointId: _drop, ...withoutEndpointId } = validRecord;
  const res = (await fakeIpcMain.invoke(
    IPC.modelHealthRecord,
    withoutEndpointId,
  )) as ModelHealthRecordResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /endpointId/);

  const list = (await fakeIpcMain.invoke(IPC.modelHealthList, {})) as ModelHealthListResult;
  assert.deepEqual(list.store, {}, "a rejected record must never be written to disk");
});

test("modelHealthRecord: rejects a missing model and never reaches the store", async () => {
  const { model: _drop, ...withoutModel } = validRecord;
  const res = (await fakeIpcMain.invoke(
    IPC.modelHealthRecord,
    withoutModel,
  )) as ModelHealthRecordResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /model/);

  const list = (await fakeIpcMain.invoke(IPC.modelHealthList, {})) as ModelHealthListResult;
  assert.deepEqual(list.store, {}, "a rejected record must never be written to disk");
});

test("modelHealthRecord: rejects a non-object arg (e.g. null/undefined) defensively", async () => {
  const res = (await fakeIpcMain.invoke(IPC.modelHealthRecord, null)) as ModelHealthRecordResult;
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /endpointId|model/);
});

test("modelHealthRecord: rejects a partial record with only endpointId+model set, and never reaches the store", async () => {
  // The exact reported repro: a call with just `{endpointId, model}` used to pass the old
  // handler's shallow check, persist verbatim, and crash Settings ▸ Model Health's render on
  // the next read (`record.contextWindow.toLocaleString()` against an undefined `contextWindow`).
  const res = (await fakeIpcMain.invoke(IPC.modelHealthRecord, {
    endpointId: "ep-partial",
    model: "m",
  })) as ModelHealthRecordResult;
  assert.equal(res.ok, false);

  const list = (await fakeIpcMain.invoke(IPC.modelHealthList, {})) as ModelHealthListResult;
  assert.equal(
    list.store?.["ep-partial"],
    undefined,
    "a malformed partial record must never be written to disk",
  );
});

test("modelHealthRecord: rejects an otherwise-complete record with an invalid breakerState enum value", async () => {
  const res = (await fakeIpcMain.invoke(IPC.modelHealthRecord, {
    ...validRecord,
    endpointId: "ep-bad-enum",
    breakerState: "tripped",
  })) as ModelHealthRecordResult;
  assert.equal(res.ok, false);

  const list = (await fakeIpcMain.invoke(IPC.modelHealthList, {})) as ModelHealthListResult;
  assert.equal(list.store?.["ep-bad-enum"], undefined);
});

test("modelHealthRecord: persists a valid-shaped record, and a follow-up list reflects it", async () => {
  const res = (await fakeIpcMain.invoke(
    IPC.modelHealthRecord,
    validRecord,
  )) as ModelHealthRecordResult;
  assert.equal(res.ok, true);
  assert.equal(res.error, undefined);

  const list = (await fakeIpcMain.invoke(IPC.modelHealthList, {})) as ModelHealthListResult;
  assert.equal(list.ok, true);
  assert.deepEqual(list.store?.["ep-1"], validRecord);
  assert.equal(Object.keys(list.store ?? {}).length, 1);
});

test("modelHealthRecord: a second record under a different endpointId adds to, not replaces, the store", async () => {
  const second = {
    ...validRecord,
    endpointId: "ep-2",
    model: "claude",
    locality: "local" as const,
  };
  const res = (await fakeIpcMain.invoke(IPC.modelHealthRecord, second)) as ModelHealthRecordResult;
  assert.equal(res.ok, true);

  const list = (await fakeIpcMain.invoke(IPC.modelHealthList, {})) as ModelHealthListResult;
  assert.deepEqual(Object.keys(list.store ?? {}).sort(), ["ep-1", "ep-2"]);
  assert.deepEqual(list.store?.["ep-2"], second);
  assert.deepEqual(list.store?.["ep-1"], validRecord, "the earlier record must be untouched");
});

test("modelHealthRecord: recording again under an existing endpointId overwrites that entry (merge-by-key)", async () => {
  const updated = { ...validRecord, nativeCalls: 42, lastUsedIso: "2026-08-19T00:00:00.000Z" };
  const res = (await fakeIpcMain.invoke(IPC.modelHealthRecord, updated)) as ModelHealthRecordResult;
  assert.equal(res.ok, true);

  const list = (await fakeIpcMain.invoke(IPC.modelHealthList, {})) as ModelHealthListResult;
  assert.equal(Object.keys(list.store ?? {}).length, 2, "still 2 endpoints, not 3");
  assert.deepEqual(list.store?.["ep-1"], updated);
});

test("registerModelHealthIpcHandlers: a full dispose lets re-registration succeed (window-reload safety)", () => {
  assert.deepEqual(
    [...fakeIpcMain.handledChannels()].sort(),
    [IPC.modelHealthList, IPC.modelHealthRecord].sort(),
  );
  for (const channel of [IPC.modelHealthList, IPC.modelHealthRecord]) {
    fakeIpcMain.removeHandler(channel);
  }
  assert.equal(fakeIpcMain.handledChannels().size, 0);

  assert.doesNotThrow(() => {
    registerModelHealthIpcHandlers(globalPath);
  }, "re-registering after a full dispose must not throw double-registration");
  assert.deepEqual(
    [...fakeIpcMain.handledChannels()].sort(),
    [IPC.modelHealthList, IPC.modelHealthRecord].sort(),
  );
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
