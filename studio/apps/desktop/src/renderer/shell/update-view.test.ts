/**
 * update-view.test.ts — the update banner state machine (APP-005).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  UPDATE_IDLE,
  updateActionLabel,
  updateOnAvailable,
  updateOnDismiss,
  updateOnDownloadError,
  updateOnDownloadStart,
  updateOnProgress,
  updateOnReady,
} from "./update-view.js";

test("happy path: available → downloading → ready, install label only at ready", () => {
  const avail = updateOnAvailable(UPDATE_IDLE, { version: "1.2.3" });
  assert.equal(avail.phase, "available");
  assert.equal(avail.version, "1.2.3");
  assert.equal(updateActionLabel(avail), "Download");

  const dl = updateOnDownloadStart(avail);
  assert.equal(dl.phase, "downloading");

  const p = updateOnProgress(dl, { percent: 41.7 });
  assert.equal(p.percent, 42); // electron-updater floats are rounded
  assert.equal(updateActionLabel(p), "42%");

  const ready = updateOnReady(p);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.percent, 100);
  assert.equal(updateActionLabel(ready), "Restart to update");
});

test("no version announced → stays idle (banner renders nothing on ok:false/null)", () => {
  assert.equal(updateOnAvailable(UPDATE_IDLE, {}).phase, "idle");
  assert.equal(updateOnAvailable(UPDATE_IDLE, { version: "" }).phase, "idle");
});

test("repeat announce during download/ready never resets progress", () => {
  const dl = updateOnDownloadStart(updateOnAvailable(UPDATE_IDLE, { version: "1.2.3" }));
  const mid = updateOnProgress(dl, { percent: 80 });
  assert.equal(updateOnAvailable(mid, { version: "1.2.3" }), mid);
  const ready = updateOnReady(mid);
  assert.equal(updateOnAvailable(ready, { version: "1.2.3" }), ready);
});

test("progress outside downloading is ignored; junk percent clamps", () => {
  const avail = updateOnAvailable(UPDATE_IDLE, { version: "2.0.0" });
  assert.equal(updateOnProgress(avail, { percent: 50 }), avail);
  const dl = updateOnDownloadStart(avail);
  assert.equal(updateOnProgress(dl, { percent: 250 }).percent, 100);
  assert.equal(updateOnProgress(dl, { percent: Number.NaN }).percent, 0);
  assert.equal(updateOnProgress(dl, {}).percent, 0);
});

test("download error falls back to available with the message", () => {
  const dl = updateOnDownloadStart(updateOnAvailable(UPDATE_IDLE, { version: "1.2.3" }));
  const failed = updateOnDownloadError(dl, "net down");
  assert.equal(failed.phase, "available");
  assert.equal(failed.error, "net down");
  assert.equal(failed.version, "1.2.3"); // offer survives the failure
});

test("ready without a prior announce is not renderable; dismiss resets fully", () => {
  assert.equal(updateOnReady(UPDATE_IDLE).phase, "idle");
  const ready = updateOnReady(updateOnAvailable(UPDATE_IDLE, { version: "3.0.0" }));
  assert.deepEqual(updateOnDismiss(ready), UPDATE_IDLE);
});
