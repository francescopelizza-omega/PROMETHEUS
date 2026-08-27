/**
 * todo.test.ts — the structured task list.
 *
 * The tolerance tests are the point. A model that mistypes one status must not lose its whole
 * plan, and a model that sends the list as a JSON string (which they do, constantly) must not
 * silently get an empty list back and conclude it has no tasks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_TODOS,
  TODO_READ_TOOL,
  TODO_WRITE_TOOL,
  TodoStore,
  parseTodos,
  renderTodos,
  runTodoTool,
  todoSummary,
} from "./todo.js";

test("a well-formed list parses", () => {
  const items = parseTodos([
    { text: "read the file", status: "completed" },
    { text: "edit it", status: "in_progress" },
    { text: "run the tests", status: "pending" },
  ]);
  assert.equal(items.length, 3);
  assert.deepEqual(items[1], { text: "edit it", status: "in_progress" });
});

test("a JSON STRING is parsed — models send one constantly", () => {
  const items = parseTodos('[{"text":"a","status":"pending"}]');
  assert.deepEqual(items, [{ text: "a", status: "pending" }]);
});

test("a bare string list becomes pending tasks", () => {
  assert.deepEqual(parseTodos(["one", "two"]), [
    { text: "one", status: "pending" },
    { text: "two", status: "pending" },
  ]);
});

test("an unknown status degrades to pending rather than losing the plan", () => {
  // Rejecting the whole write over one typo'd enum is a worse failure than a wrong status.
  const items = parseTodos([
    { text: "a", status: "doing" },
    { text: "b", status: "DONE" },
  ]);
  assert.deepEqual(
    items.map((t) => t.status),
    ["pending", "pending"],
  );
});

test("an item with no text is dropped — it has nothing to show a human", () => {
  assert.deepEqual(parseTodos([{ status: "pending" }, { text: "   " }, { text: "real" }]), [
    { text: "real", status: "pending" },
  ]);
});

test("garbage yields an empty list, never a throw", () => {
  for (const bad of [null, undefined, 42, "not json", {}, [1, 2, 3]]) {
    assert.deepEqual(parseTodos(bad), [], `threw or invented on ${String(bad)}`);
  }
});

test("the list is capped so a runaway model cannot fill the screen", () => {
  const many = Array.from({ length: MAX_TODOS + 25 }, (_, i) => ({ text: `t${i}` }));
  assert.equal(parseTodos(many).length, MAX_TODOS);
});

/* ── the store ───────────────────────────────────────────────────────────────*/

test("a write REPLACES the list — it is not a patch", () => {
  // Wholesale replace removes a class of desync: a model that must send a diff sends a wrong
  // diff (loses items, duplicates them, renumbers).
  const store = new TodoStore();
  store.write([{ text: "a" }, { text: "b" }]);
  store.write([{ text: "c", status: "completed" }]);
  assert.deepEqual(store.list(), [{ text: "c", status: "completed" }]);
});

test("todowrite reports the summary, and todoread reads it back", () => {
  const store = new TodoStore();
  const w = runTodoTool(
    "todowrite",
    { todos: [{ text: "a", status: "completed" }, { text: "b" }] },
    store,
  );
  assert.equal(w?.ok, true);
  assert.match(w?.summary ?? "", /1\/2 done/);
  const r = runTodoTool("todoread", {}, store);
  assert.match(r?.summary ?? "", /● a/);
  assert.match(r?.summary ?? "", /○ b/);
});

test("an unrelated tool name is NOT handled here", () => {
  // The dispatcher must fall through, or the todo arm would swallow every other tool.
  assert.equal(runTodoTool("read_file", { path: "a" }, new TodoStore()), null);
});

test("an empty list renders as words, not as nothing", () => {
  assert.equal(renderTodos([]), "(no tasks yet)");
  assert.equal(todoSummary([]), "no tasks");
});

test("the summary counts in-progress separately", () => {
  const items = parseTodos([
    { text: "a", status: "completed" },
    { text: "b", status: "in_progress" },
    { text: "c" },
  ]);
  assert.equal(todoSummary(items), "1/3 done · 1 in progress");
});

/* ── the tools ───────────────────────────────────────────────────────────────*/

test("both todo tools are readOnly — writing a plan must not need a human click", () => {
  // They mutate AGENT MEMORY, never the machine. Requiring approval for the model to write
  // down its own plan would make the feature unusable, and there is nothing to approve.
  assert.equal(TODO_WRITE_TOOL.annotations.readOnlyHint, true);
  assert.equal(TODO_READ_TOOL.annotations.readOnlyHint, true);
  assert.notEqual(TODO_WRITE_TOOL.annotations.destructiveHint, true);
});

test("todowrite declares its argument as an ARRAY, not a string", () => {
  // The lesson from propose_edit.hunks: a schema that disagrees with its description is the
  // half a model follows.
  assert.equal(TODO_WRITE_TOOL.schema.todos?.type, "array");
  assert.equal(TODO_WRITE_TOOL.schema.todos?.required, true);
});

test("toArgv throws — the todo tools are host-served, never engine verbs", () => {
  assert.throws(() => TODO_WRITE_TOOL.toArgv({}), /host runtime/);
  assert.throws(() => TODO_READ_TOOL.toArgv({}), /host runtime/);
});

test("a malformed todowrite REFUSES instead of silently wiping the plan", () => {
  /**
   * `parseTodos` is deliberately forgiving — it would rather keep a task with a typo'd status
   * than lose the plan. But a payload that is not a list AT ALL parsed to the empty list, so the
   * store was cleared and the model was told `ok: true, "task list updated"`. It had just lost
   * its own plan, mid-task, with no way to know. Reproduced against the compiled module: a
   * two-item list, then `todowrite {}` → 0 items, ok: true.
   */
  const store = new TodoStore();
  runTodoTool(
    "todowrite",
    { todos: [{ text: "ship the fix", status: "in_progress" }, { text: "write the test" }] },
    store,
  );
  assert.equal(store.list().length, 2, "precondition");

  for (const [label, args] of [
    ["field omitted", {}],
    ["a bare string", { todos: "ship it" }],
    ["an object", { todos: { a: 1 } }],
    ["an array with nothing usable in it", { todos: [null, {}, ""] }],
  ] as const) {
    const out = runTodoTool("todowrite", args as Record<string, unknown>, store);
    assert.equal(out?.ok, false, `${label} was accepted`);
    assert.match(out?.summary ?? "", /UNCHANGED|nothing was written/);
    assert.equal(store.list().length, 2, `${label} wiped the plan`);
  }

  // an EXPLICIT empty array is a legitimate "clear the list" and must still work
  const cleared = runTodoTool("todowrite", { todos: [] }, store);
  assert.equal(cleared?.ok, true);
  assert.equal(store.list().length, 0);

  // …and a JSON string holding a real array is still accepted (some models send one)
  const viaString = runTodoTool("todowrite", { todos: JSON.stringify([{ text: "x" }]) }, store);
  assert.equal(viaString?.ok, true);
  assert.equal(store.list().length, 1);
});
