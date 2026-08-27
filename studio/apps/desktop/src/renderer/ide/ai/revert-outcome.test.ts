/**
 * revert-outcome.test.ts — a revert may only claim what the disk actually did.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type RevertStepResult, revertOutcome } from "./revert-outcome.js";

const ok = (path: string, kind: RevertStepResult["kind"] = "write"): RevertStepResult => ({
  path,
  kind,
  ok: true,
});
const bad = (path: string, error?: string): RevertStepResult => ({
  path,
  kind: "write",
  ok: false,
  ...(error ? { error } : {}),
});

test("a clean revert truncates the chat", () => {
  const out = revertOutcome([ok("a.ts"), ok("b.ts", "delete")]);
  assert.equal(out.truncate, true);
  assert.equal(out.notice, "");
  assert.deepEqual(out.failed, []);
});

test("an EMPTY plan is a success — a turn that touched no files reverts trivially", () => {
  // refusing here would make Revert look broken on the commonest case.
  assert.equal(revertOutcome([]).truncate, true);
});

test("one failed write keeps the transcript — it is the only record of what is still on disk", () => {
  // regression: both fs calls ended in `.catch(() => undefined)` and the resolved `{ok:false}`
  // was never read, so the chat was truncated unconditionally. The code's own comment says the
  // fs-then-truncate ordering exists to stop "a reverted chat over an unreverted disk".
  const out = revertOutcome([ok("a.ts"), bad("src/b.ts", "EACCES: permission denied")]);
  assert.equal(out.truncate, false, "a partial revert must not rewind the conversation");
  assert.deepEqual(out.failed, ["src/b.ts"]);
  assert.match(out.notice, /revert incomplete/);
  assert.match(out.notice, /src\/b\.ts/);
  assert.match(out.notice, /permission denied/, "the reason changes what the user should do");
});

test("many failures are summarised, not dumped", () => {
  const out = revertOutcome(["a", "b", "c", "d", "e"].map((p) => bad(`${p}.ts`)));
  assert.equal(out.truncate, false);
  assert.equal(out.failed.length, 5);
  assert.match(out.notice, /and 2 more/);
});

test("a failed DELETE counts too — it leaves a file the reverted turn created", () => {
  const out = revertOutcome([{ path: "new.ts", kind: "delete", ok: false }]);
  assert.equal(out.truncate, false);
  assert.deepEqual(out.failed, ["new.ts"]);
});

test("singular/plural is not mangled", () => {
  assert.match(revertOutcome([bad("a.ts")]).notice, /1 file could not be restored/);
  assert.match(revertOutcome([bad("a.ts"), bad("b.ts")]).notice, /2 files could not be restored/);
});
