/**
 * path-guard.test.ts — what the user is TOLD when the working set belongs to another project.
 *
 * The scope policy itself is pinned by `working-set.test.ts` (a renderer cannot widen its own
 * scope; `/` does not put the filesystem in scope; an empty declaration does not disable the
 * guard). Those properties depend on the grants fallback, so the fallback is correct and is not
 * changed here.
 *
 * What WAS wrong is the diagnosis. Opening a project by a route that records no grant — Home ▸ a
 * recent project, drag-drop, a worktree switch — pins the guard to the folder the human last
 * picked through the native dialog, and every save in the project actually on screen is refused.
 * Reproduced: grant projA, declare [projB] → roots in force `[projA]`, projB refused, projA
 * allowed. The message said only "not approved", which reads as a problem with the FILE.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertInsideWorkingSet,
  clearGrantedRoots,
  getWorkingSetRoots,
  grantWorkingSetRoot,
  setWorkingSetRoots,
} from "./path-guard.js";

test("a save blocked by another project's scope says WHY, not just 'not approved'", () => {
  clearGrantedRoots();
  grantWorkingSetRoot("/tmp/pg-a");
  const out = setWorkingSetRoots(["/tmp/pg-b"]);
  assert.equal(out.accepted, 0);
  assert.deepEqual(out.refused.length, 1, "the refusal must still be reported to the caller");
  // the documented fallback: the guard stays pinned to what the human DID open
  assert.deepEqual([...getWorkingSetRoots()], ["/private/tmp/pg-a"]);

  assert.throws(
    () => assertInsideWorkingSet("/tmp/pg-b/file.txt"),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /outside the working set/);
      assert.match(msg, /opened from recents/, "the message does not name the actual cause");
      assert.match(msg, /Open Folder/, "the message gives the user nothing to do");
      return true;
    },
  );
  clearGrantedRoots();
});

test("an ordinary out-of-scope write keeps the plain refusal", () => {
  // self-validating: the hint must not be pasted onto every refusal — a file genuinely outside a
  // correctly-declared working set is a different situation and reads wrong with that advice.
  clearGrantedRoots();
  grantWorkingSetRoot("/tmp/pg-a");
  setWorkingSetRoots(["/tmp/pg-a"]);
  assert.throws(() => assertInsideWorkingSet("/tmp/pg-a/../pg-c/x.txt"), /outside the working set/);
  clearGrantedRoots();
});
