/**
 * replace-apply.test.ts — bulk replace-in-files must count only what actually landed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyReplacements } from "./replace-apply.js";

const FILES = [{ uri: "file:///a.ts" }, { uri: "file:///b.ts" }, { uri: "file:///c.ts" }];
const accepted = () => ["m1"];
const applied = () => ({ ok: true as const, applied: 1, text: "NEW" });

test("a REFUSED write is reported, never counted as replaced", async () => {
  /**
   * Both replace paths awaited `fsWrite` and discarded the result, then incremented the counters
   * anyway — so a refused or failed write was indistinguishable from a success and the panel
   * still announced "replaced N matches in M files". A scope directory outside the granted
   * working set, or a single read-only file, produced a confident success message over a file
   * that had not changed. Discovery and preview both succeed in that case, which is what made it
   * look like it had worked.
   */
  const written: string[] = [];
  const tally = await applyReplacements(
    {
      read: async () => ({ ok: true, text: "OLD" }),
      write: async (uri) => {
        if (uri === "file:///b.ts") return { ok: false, error: "EACCES: permission denied" };
        written.push(uri);
        return { ok: true };
      },
    },
    FILES,
    accepted,
    applied,
  );

  assert.deepEqual(written, ["file:///a.ts", "file:///c.ts"]);
  assert.equal(tally.files, 2, "the refused file was counted as replaced");
  assert.equal(tally.matches, 2, "the refused file's matches were counted as replaced");
  assert.deepEqual(tally.failed, [{ uri: "file:///b.ts", error: "EACCES: permission denied" }]);
});

test("a write that THROWS is a failure, not a success", async () => {
  const tally = await applyReplacements(
    {
      read: async () => ({ ok: true, text: "OLD" }),
      write: async () => {
        throw new Error("bridge went away");
      },
    },
    [FILES[0]!],
    accepted,
    applied,
  );
  assert.equal(tally.files, 0);
  assert.equal(tally.failed.length, 1);
});

test("stale and unreadable files are SKIPPED, which is a different thing from failed", async () => {
  // "changed since preview" is not an error — the user is told to re-run the search. Keeping the
  // two tallies apart is what lets the notice say which happened.
  const stale = await applyReplacements(
    { read: async () => ({ ok: true, text: "OLD" }), write: async () => ({ ok: true }) },
    [FILES[0]!],
    accepted,
    () => ({ ok: false as const, stale: 1 }),
  );
  assert.equal(stale.skipped, 1);
  assert.deepEqual(stale.failed, []);
  assert.equal(stale.files, 0);

  const unreadable = await applyReplacements(
    { read: async () => ({ ok: false }), write: async () => ({ ok: true }) },
    [FILES[0]!],
    accepted,
    applied,
  );
  assert.equal(unreadable.skipped, 1);
  assert.deepEqual(unreadable.failed, []);
});

test("the all-succeeded path still tallies everything", async () => {
  const tally = await applyReplacements(
    { read: async () => ({ ok: true, text: "OLD" }), write: async () => ({ ok: true }) },
    FILES,
    accepted,
    () => ({ ok: true as const, applied: 3, text: "NEW" }),
  );
  assert.equal(tally.files, 3);
  assert.equal(tally.matches, 9);
  assert.deepEqual(tally.failed, []);
  assert.equal(tally.skipped, 0);
});
