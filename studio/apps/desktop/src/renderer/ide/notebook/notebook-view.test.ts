/**
 * notebook-view.test.ts — node:test for the pure notebook cell-list reducer (APP-045).
 * Focus on the streaming additions (append-output, hydrate, run-error execCount) plus
 * the core add/remove/move invariants. Pure — no react/monaco.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Cell, cellReducer, executionSummary, nextCellId } from "./notebook-view.js";

const cell = (id: string, over: Partial<Cell> = {}): Cell => ({
  id,
  kind: "code",
  source: "",
  status: "idle",
  ...over,
});

test("run-start clears outputs and marks running", () => {
  const s = cellReducer([cell("a", { outputs: [{ mime: "text/plain", data: "old" }] })], {
    type: "run-start",
    id: "a",
  });
  assert.equal(s[0]!.status, "running");
  assert.deepEqual(s[0]!.outputs, []);
});

test("append-output appends incrementally in order", () => {
  let s = cellReducer([cell("a", { status: "running", outputs: [] })], {
    type: "append-output",
    id: "a",
    output: { mime: "text/plain", data: "one" },
  });
  s = cellReducer(s, {
    type: "append-output",
    id: "a",
    output: { mime: "text/plain", data: "two" },
  });
  assert.deepEqual(
    s[0]!.outputs!.map((o) => o.data),
    ["one", "two"],
  );
});

test("run-ok keeps streamed outputs when none passed and stamps execCount", () => {
  let s = cellReducer([cell("a", { status: "running" })], {
    type: "append-output",
    id: "a",
    output: { mime: "text/plain", data: "hi" },
  });
  s = cellReducer(s, { type: "run-ok", id: "a", execCount: 5 });
  assert.equal(s[0]!.status, "ok");
  assert.equal(s[0]!.execCount, 5);
  assert.deepEqual(s[0]!.outputs, [{ mime: "text/plain", data: "hi" }]);
});

test("run-error stamps status + execCount and preserves outputs", () => {
  let s = cellReducer(
    [cell("a", { status: "running", outputs: [{ mime: "text/plain", data: "tb" }] })],
    {
      type: "run-error",
      id: "a",
      execCount: 2,
    },
  );
  assert.equal(s[0]!.status, "error");
  assert.equal(s[0]!.execCount, 2);
  assert.deepEqual(s[0]!.outputs, [{ mime: "text/plain", data: "tb" }]);
  s = cellReducer(s, { type: "hydrate", cells: [cell("z")] });
  assert.deepEqual(
    s.map((c) => c.id),
    ["z"],
  );
});

test("hydrate replaces the whole list", () => {
  const s = cellReducer([cell("a"), cell("b")], {
    type: "hydrate",
    cells: [cell("x"), cell("y"), cell("z")],
  });
  assert.equal(s.length, 3);
  assert.equal(s[2]!.id, "z");
});

test("add/remove/move + summary + nextCellId still hold", () => {
  let s = cellReducer([], { type: "add", id: "a" });
  s = cellReducer(s, { type: "add", id: "b", afterId: "a" });
  s = cellReducer(s, { type: "move", id: "b", dir: "up" });
  assert.deepEqual(
    s.map((c) => c.id),
    ["b", "a"],
  );
  s = cellReducer(s, { type: "run-ok", id: "a" });
  s = cellReducer(s, { type: "run-error", id: "b" });
  const sum = executionSummary(s);
  assert.deepEqual(sum, { running: 0, ok: 1, errors: 1 });
  assert.equal(nextCellId(s, "b"), "a");
  assert.equal(nextCellId(s, "a"), undefined);
});
