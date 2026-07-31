/**
 * changelists.test.ts — node:test for the PURE changelist reducers (APP-038).
 *
 * Pins the invariants the git-index choreography relies on: Default is the sink and
 * is undeletable; names are unique (case-sensitive); moveFiles is exclusive across
 * lists; assignNewFiles sinks unknown status files; reconcile drops vanished files.
 * All reducers are immutable + total.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Changelist,
  DEFAULT_CHANGELIST_ID,
  assignNewFiles,
  createList,
  defaultChangelist,
  deleteList,
  moveFiles,
  reconcile,
  renameList,
  withDefault,
} from "./changelists.js";

const base = (): Changelist[] => [defaultChangelist()];

test("defaultChangelist is the undeletable sink with a stable id", () => {
  const d = defaultChangelist();
  assert.equal(d.id, DEFAULT_CHANGELIST_ID);
  assert.equal(d.isDefault, true);
  assert.deepEqual(d.files, []);
});

test("withDefault prepends a Default only when one is absent", () => {
  assert.equal(withDefault([]).length, 1);
  assert.equal(withDefault([])[0]?.isDefault, true);
  const already = base();
  assert.equal(withDefault(already).length, 1); // no duplicate Default
});

test("createList adds a named list; rejects empty + duplicate names (no-op by identity)", () => {
  const l1 = createList(base(), "Feature A", "a");
  assert.deepEqual(
    l1.map((l) => l.name),
    ["Changes", "Feature A"],
  );
  const empty = createList(l1, "   ", "b");
  assert.equal(empty, l1); // no-op: same reference
  const dup = createList(l1, "Feature A", "c");
  assert.equal(dup, l1); // collision → no-op
});

test("createList name uniqueness is case-sensitive", () => {
  const l1 = createList(base(), "Feature", "a");
  const l2 = createList(l1, "feature", "b"); // different case = distinct
  assert.equal(l2.length, 3);
});

test("renameList renames; rejects a collision with a different list", () => {
  let lists = createList(base(), "A", "a");
  lists = createList(lists, "B", "b");
  const ok = renameList(lists, "a", "A2");
  assert.equal(ok.find((l) => l.id === "a")?.name, "A2");
  const collide = renameList(ok, "a", "B"); // B already exists
  assert.equal(collide, ok); // no-op
});

test("deleteList reassigns members to Default; Default itself is undeletable", () => {
  let lists = createList(base(), "A", "a");
  lists = moveFiles(lists, "a", ["x.ts", "y.ts"]);
  const afterDelete = deleteList(lists, "a");
  assert.ok(!afterDelete.some((l) => l.id === "a"));
  assert.deepEqual(afterDelete.find((l) => l.isDefault)?.files.sort(), ["x.ts", "y.ts"]);
  // deleting Default is a no-op
  assert.equal(deleteList(afterDelete, DEFAULT_CHANGELIST_ID), afterDelete);
  // deleting an unknown id is a no-op
  assert.equal(deleteList(afterDelete, "ghost"), afterDelete);
});

test("moveFiles is exclusive: a file lands in the target and leaves every other list", () => {
  let lists = createList(base(), "A", "a");
  lists = createList(lists, "B", "b");
  lists = moveFiles(lists, "a", ["f.ts"]); // f.ts in A
  lists = moveFiles(lists, "b", ["f.ts"]); // f.ts moves to B, removed from A
  assert.deepEqual(lists.find((l) => l.id === "a")?.files, []);
  assert.deepEqual(lists.find((l) => l.id === "b")?.files, ["f.ts"]);
});

test("assignNewFiles sinks only UNKNOWN status files into Default", () => {
  let lists = createList(base(), "A", "a");
  lists = moveFiles(lists, "a", ["known.ts"]);
  const next = assignNewFiles(lists, ["known.ts", "fresh1.ts", "fresh2.ts"]);
  // known.ts stays in A; only the fresh ones sink to Default
  assert.deepEqual(next.find((l) => l.id === "a")?.files, ["known.ts"]);
  assert.deepEqual(next.find((l) => l.isDefault)?.files.sort(), ["fresh1.ts", "fresh2.ts"]);
});

test("assignNewFiles creates a Default when the list set has none", () => {
  const next = assignNewFiles([], ["a.ts"]);
  assert.equal(
    next.some((l) => l.isDefault),
    true,
  );
  assert.deepEqual(next.find((l) => l.isDefault)?.files, ["a.ts"]);
});

test("reconcile drops list members no longer present in git status", () => {
  let lists = createList(base(), "A", "a");
  lists = moveFiles(lists, "a", ["stays.ts", "gone.ts"]);
  const reconciled = reconcile(lists, ["stays.ts", "other.ts"]);
  assert.deepEqual(reconciled.find((l) => l.id === "a")?.files, ["stays.ts"]); // gone.ts dropped
});

test("reducers never mutate their input", () => {
  const lists = moveFiles(createList(base(), "A", "a"), "a", ["x.ts"]);
  const snapshot = JSON.parse(JSON.stringify(lists));
  createList(lists, "B", "b");
  deleteList(lists, "a");
  reconcile(lists, []);
  assert.deepEqual(lists, snapshot);
});
