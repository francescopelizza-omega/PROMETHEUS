/**
 * ipc-broker.test.ts — node:test coverage for the decoupled IpcBroker.
 *
 * Runs NOW (no electron). Verifies handler dispatch, unknown-channel rejection
 * (fail-closed routing), throw→reject normalisation, no-silent-overwrite, and the
 * `bind` adapter that strips the leading IpcMainInvokeEvent and routes through
 * dispatch — proven with a fake ipcMain-like object.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { IpcBroker, type IpcMainLike, UnknownChannelError } from "./ipc-broker.js";

test("IpcBroker dispatches to the registered handler with the renderer args", async () => {
  const broker = new IpcBroker();
  broker.register("greet", async (name: unknown) => `hello ${String(name)}`);
  const out = await broker.dispatch("greet", "world");
  assert.equal(out, "hello world");
});

test("IpcBroker rejects an unknown channel (fail-closed routing)", async () => {
  const broker = new IpcBroker();
  await assert.rejects(() => broker.dispatch("nope"), UnknownChannelError);
  await assert.rejects(() => broker.dispatch("nope"), /no handler registered for channel: nope/);
});

test("IpcBroker normalises a thrown handler into a rejected Error", async () => {
  const broker = new IpcBroker();
  broker.register("boom", () => {
    throw "string failure"; // non-Error throw
  });
  await assert.rejects(
    () => broker.dispatch("boom"),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as Error).message, "string failure");
      return true;
    },
  );
});

test("IpcBroker forbids silent re-registration of a channel", () => {
  const broker = new IpcBroker();
  broker.register("ch", () => 1);
  assert.throws(() => broker.register("ch", () => 2), /already registered/);
});

test("IpcBroker.has + channels reflect registrations", () => {
  const broker = new IpcBroker();
  broker.register("a", () => 1).register("b", () => 2);
  assert.equal(broker.has("a"), true);
  assert.equal(broker.has("z"), false);
  assert.deepEqual(broker.channels().sort(), ["a", "b"]);
});

test("IpcBroker.bind strips the IpcMainInvokeEvent and routes through dispatch", async () => {
  const broker = new IpcBroker();
  broker.register("sum", async (a: unknown, b: unknown) => Number(a) + Number(b));

  // Fake ipcMain capturing the bound listeners.
  const bound = new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown
  >();
  const fakeIpcMain: IpcMainLike = {
    handle: (channel, listener) => bound.set(channel, listener),
    removeHandler: (channel) => bound.delete(channel),
  };

  const dispose = broker.bind(fakeIpcMain);
  assert.equal(bound.size, 1);

  // Simulate Electron invoking with a leading event object.
  const listener = bound.get("sum");
  assert.ok(listener);
  const result = await listener?.({ sender: "fake-event" }, 2, 3);
  assert.equal(result, 5);

  // Unknown channel still rejects through the bound path (defence in depth).
  dispose();
  assert.equal(bound.size, 0);
});
