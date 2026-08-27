/**
 * permission-queue.test.ts — the §3 write-permission queue must be per session.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PermissionQueues,
  answerHeadFor,
  clearFor,
  headFor,
  raiseFor,
} from "./permission-queue.js";

const w = (path: string) => ({ path, change: "write", insideWorkingSet: true });

test("answering one tab's card cannot consume or apply another tab's", () => {
  /**
   * One DiffReview instance renders whichever chat tab is active, so its state must be keyed by
   * session. `applyingBy` and `errorBy` already were, with a comment explaining why; the
   * permission queue was flat. A card raised for tab A therefore stayed on screen after
   * switching to tab B, and approving it ran the apply against B's ChangeSet — B's files written
   * on a permission the human granted for a path in tab A, with B's own paths never shown, while
   * A's approved apply silently never happened.
   */
  let q: PermissionQueues = {};
  q = raiseFor(q, "tab-a", [w("/ws/a1.ts"), w("/ws/a2.ts")]);
  q = raiseFor(q, "tab-b", [w("/ws/b1.ts")]);

  // each tab sees ITS OWN head, never the other's
  assert.equal(headFor(q, "tab-a")?.path, "/ws/a1.ts");
  assert.equal(headFor(q, "tab-b")?.path, "/ws/b1.ts");

  // answering A pops only A's, and A is not drained yet
  const afterA = answerHeadFor(q, "tab-a");
  assert.equal(afterA.drained, false, "A still has a second path to show the human");
  assert.equal(headFor(afterA.queues, "tab-a")?.path, "/ws/a2.ts");
  assert.equal(headFor(afterA.queues, "tab-b")?.path, "/ws/b1.ts", "B's queue was disturbed");

  // draining A does not drain B
  const drainedA = answerHeadFor(afterA.queues, "tab-a");
  assert.equal(drainedA.drained, true, "A is drained — this is what triggers A's apply");
  assert.equal(headFor(drainedA.queues, "tab-b")?.path, "/ws/b1.ts");
});

test("a deny cancels only the denying session's apply", () => {
  let q: PermissionQueues = {};
  q = raiseFor(q, "tab-a", [w("/ws/a1.ts")]);
  q = raiseFor(q, "tab-b", [w("/ws/b1.ts")]);
  const afterDeny = clearFor(q, "tab-a");
  assert.equal(headFor(afterDeny, "tab-a"), undefined);
  assert.equal(headFor(afterDeny, "tab-b")?.path, "/ws/b1.ts", "the other tab was cancelled too");
});

test("a session with nothing pending shows no card, and draining an empty queue is safe", () => {
  const q: PermissionQueues = {};
  assert.equal(headFor(q, "never-asked"), undefined);
  const out = answerHeadFor(q, "never-asked");
  assert.equal(out.drained, true);
  assert.deepEqual(out.queues["never-asked"], []);
});
