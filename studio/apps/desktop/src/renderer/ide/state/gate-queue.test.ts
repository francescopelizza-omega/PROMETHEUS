/**
 * gate-queue.test.ts — node:test for the buffered §5.2 run-gate handoff.
 *
 * Pins the fail-closed contract: uris enqueued while no listener exists survive
 * until drained; draining empties the queue exactly once.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { drainGateUris, enqueueGateUris, hasPendingGateUris } from "./gate-queue.js";

test("enqueue → drain hands back every uri exactly once", () => {
  drainGateUris(); // isolate from other tests
  enqueueGateUris(["file:///w/a.py"]);
  enqueueGateUris(["file:///w/b.py", "file:///w/c.py"]);
  assert.equal(hasPendingGateUris(), true);
  assert.deepEqual(drainGateUris(), ["file:///w/a.py", "file:///w/b.py", "file:///w/c.py"]);
  assert.equal(hasPendingGateUris(), false);
  assert.deepEqual(drainGateUris(), []); // a second drain is empty, never a replay
});
