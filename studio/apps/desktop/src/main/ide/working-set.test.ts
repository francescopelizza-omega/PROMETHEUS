/**
 * working-set.test.ts — the §3 applier scope guard.
 *
 * This is the half of the permission story that is NOT a UI. The renderer's permission
 * card can be skipped, bypassed, or simply not rendered; MAIN's guard is what actually
 * stops a write outside the working set. So it gets tests, and the UI does not.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  approveOutsideWorkingSet,
  assertInsideWorkingSet,
  clearOutsideApprovals,
  getWorkingSetRoots,
  isInsideWorkingSet,
  setWorkingSetRoots,
} from "./path-guard.js";

/** realpath: macOS /var → /private/var, and the guard canonicalises both sides. */
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "prom-ws-")));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), "prom-out-")));

test("no roots declared ⇒ the scope check is OFF (a loose file can still be saved)", () => {
  setWorkingSetRoots([]);
  assert.equal(getWorkingSetRoots().length, 0);
  assert.equal(isInsideWorkingSet(join(OUTSIDE, "a.txt")), true);
  assert.doesNotThrow(() => assertInsideWorkingSet(join(OUTSIDE, "a.txt")));
});

test("a path inside the working set is allowed", () => {
  setWorkingSetRoots([ROOT]);
  assert.equal(isInsideWorkingSet(join(ROOT, "src", "a.ts")), true);
  assert.equal(assertInsideWorkingSet(join(ROOT, "src", "a.ts")), join(ROOT, "src", "a.ts"));
});

test("a path OUTSIDE the working set is REFUSED (fail-closed)", () => {
  setWorkingSetRoots([ROOT]);
  assert.equal(isInsideWorkingSet(join(OUTSIDE, "evil.sh")), false);
  assert.throws(() => assertInsideWorkingSet(join(OUTSIDE, "evil.sh")), /outside the working set/);
});

test("a sibling directory sharing the root's PREFIX is not inside it", () => {
  // `/tmp/ws` must not admit `/tmp/ws-evil` — a naive startsWith() would.
  setWorkingSetRoots([ROOT]);
  assert.equal(isInsideWorkingSet(`${ROOT}-evil/x.ts`), false);
  assert.throws(() => assertInsideWorkingSet(`${ROOT}-evil/x.ts`), /outside the working set/);
});

test("`..` cannot escape the root (the path is canonicalised first)", () => {
  setWorkingSetRoots([ROOT]);
  assert.throws(
    () => assertInsideWorkingSet(join(ROOT, "..", "elsewhere", "x.ts")),
    /outside the working set/,
  );
});

test("an explicit per-path approval admits exactly that path and nothing else", () => {
  setWorkingSetRoots([ROOT]);
  const approved = join(OUTSIDE, "approved.txt");
  const other = join(OUTSIDE, "other.txt");
  approveOutsideWorkingSet(approved);
  assert.equal(assertInsideWorkingSet(approved), approved);
  // the approval is NOT a wildcard for its directory.
  assert.throws(() => assertInsideWorkingSet(other), /outside the working set/);
});

test("changing the roots INVALIDATES prior approvals (they were granted against the old scope)", () => {
  setWorkingSetRoots([ROOT]);
  const approved = join(OUTSIDE, "approved.txt");
  approveOutsideWorkingSet(approved);
  assert.doesNotThrow(() => assertInsideWorkingSet(approved));
  setWorkingSetRoots([ROOT]); // a re-declare is still a scope change
  assert.throws(() => assertInsideWorkingSet(approved), /outside the working set/);
});

test("clearOutsideApprovals forgets every grant", () => {
  setWorkingSetRoots([ROOT]);
  const approved = join(OUTSIDE, "approved.txt");
  approveOutsideWorkingSet(approved);
  clearOutsideApprovals();
  assert.throws(() => assertInsideWorkingSet(approved), /outside the working set/);
});

test("a file:// uri is accepted and canonicalised like a bare path", () => {
  setWorkingSetRoots([ROOT]);
  assert.doesNotThrow(() => assertInsideWorkingSet(`file://${join(ROOT, "a.ts")}`));
  assert.throws(
    () => assertInsideWorkingSet(`file://${join(OUTSIDE, "a.ts")}`),
    /outside the working set/,
  );
});

test("multiple roots: inside ANY of them is enough", () => {
  setWorkingSetRoots([ROOT, OUTSIDE]);
  assert.doesNotThrow(() => assertInsideWorkingSet(join(ROOT, "a.ts")));
  assert.doesNotThrow(() => assertInsideWorkingSet(join(OUTSIDE, "a.ts")));
});
