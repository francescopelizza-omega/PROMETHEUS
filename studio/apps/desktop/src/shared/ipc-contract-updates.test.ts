/**
 * ipc-contract-updates.test.ts — pins the updater wire protocol (APP-005).
 *
 * main/updater.ts and preload/api.ts both import these constants, so the values
 * here ARE the channel strings on the wire — this test freezes them (the spec's
 * "channel names must not change") and the {ok,...} envelope key shape.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { IPC_UPDATE, IPC_UPDATE_EVENTS } from "./ipc-contract.js";

test("update invoke channels are frozen to the main-process handler strings", () => {
  assert.deepEqual(IPC_UPDATE, {
    check: "update:check",
    download: "update:download",
    install: "update:install",
  });
});

test("update event channels are frozen to the main-process send strings", () => {
  assert.deepEqual(IPC_UPDATE_EVENTS, {
    available: "update:available",
    progress: "update:progress",
    ready: "update:ready",
  });
});
