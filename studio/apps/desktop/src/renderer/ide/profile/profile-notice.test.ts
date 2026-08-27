/**
 * profile-notice.test.ts — a partial or crashed profile must not read as a complete one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { profileNotice } from "./profile-notice.js";

/** What `profile.py` sets on EVERY successful run — measured against the real sidecar. */
const ENGINE_NOTE =
  "cProfile edge-reconstructed (approximate) folds; py-spy gives true sampled stacks";

test("a truncated run says so even though the engine note is present", () => {
  /**
   * The panel did `if (res.note) … else if (res.timedOut) …`, and the engine sets `note` on every
   * successful run — so the `timedOut` arm was UNREACHABLE. A run that hit the wall-clock cap
   * showed the generic note and nothing about being cut short, and the user read a partial flame
   * graph as a complete one.
   */
  const notice = profileNotice({ timedOut: true, note: ENGINE_NOTE });
  assert.match(notice, /wall-clock cap/, "the truncation was hidden behind the engine note");
  assert.match(notice, /cProfile/, "the engine note must still be shown, not replaced");
});

test("a crashed target is reported FIRST — the graph is not the user's code", () => {
  const notice = profileNotice({
    runError: "RuntimeError: boom",
    timedOut: true,
    note: ENGINE_NOTE,
  });
  assert.match(notice, /^⚠ the profiled script raised RuntimeError: boom/);
  assert.match(notice, /not your code/);
  // the lesser facts survive behind it
  assert.match(notice, /wall-clock cap/);
  assert.match(notice, /cProfile/);
});

test("an ordinary healthy run shows just the engine note", () => {
  // self-validating: the composer must not decorate a clean run with warnings.
  const notice = profileNotice({ note: ENGINE_NOTE });
  assert.equal(notice, ENGINE_NOTE);
});

test("a run with nothing to say produces nothing", () => {
  assert.equal(profileNotice({}), "");
  assert.equal(profileNotice({ timedOut: false, truncated: false }), "");
});
