/**
 * debug-inspect.test.ts — the pure DebugPanel inspection math (APP-030).
 *
 * Pins the acceptance invariants with an injected fake dapRequest: `variables`
 * fires exactly ONCE per node per stop (settled + in-flight dedup), a fresh cache
 * (new stop / frame switch) refetches, one failing watch never aborts the others,
 * `evaluate` args carry the selected frameId (omitted entirely when null), and
 * partial DAP bodies parse to [] instead of crashing.
 *
 * Run: node --import ../../../../../../apps/cli/dev-register.mjs --test debug-inspect.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_EXPAND_DEPTH,
  applyContinued,
  applyStopped,
  buildEvalArgs,
  evalExpression,
  evalWatches,
  expandable,
  fetchChildren,
  freshCache,
  parseFrames,
  parseScopes,
  parseSetVariableResult,
  parseThreads,
  parseVariables,
  pickStoppedThread,
} from "./debug-inspect.js";

function fakeRequest(
  log: Array<{ command: string; args: unknown }>,
  respond?: (c: string, a: unknown) => unknown,
) {
  return async (command: string, args?: unknown) => {
    log.push({ command, args });
    const body = respond?.(command, args);
    return { ok: true, body };
  };
}

test("parseScopes/parseVariables: guarded against partial/absent bodies", () => {
  assert.deepEqual(parseScopes(undefined), []);
  assert.deepEqual(parseScopes({}), []);
  assert.deepEqual(parseScopes({ scopes: "nope" }), []);
  assert.deepEqual(parseScopes({ scopes: [null, { name: "Locals", variablesReference: 3 }] }), [
    { name: "Locals", variablesReference: 3, expensive: false },
  ]);
  assert.deepEqual(
    parseScopes({ scopes: [{ name: "Globals", variablesReference: 9, expensive: true }] }),
    [{ name: "Globals", variablesReference: 9, expensive: true }],
  );
  assert.deepEqual(parseVariables({}), []);
  assert.deepEqual(parseVariables({ variables: [{ name: "x", value: "1" }] }), [
    { name: "x", value: "1", type: null, variablesReference: 0 },
  ]);
  assert.deepEqual(
    parseVariables({
      variables: [{ name: "d", value: "{…}", type: "dict", variablesReference: 12 }],
    }),
    [{ name: "d", value: "{…}", type: "dict", variablesReference: 12 }],
  );
});

test("APP-080: parseSetVariableResult echoes value/type/ref; missing fields degrade to null", () => {
  // a scalar edit: adapter echoes the new value + type, ref 0 (still a leaf).
  assert.deepEqual(parseSetVariableResult({ value: "99", type: "int", variablesReference: 0 }), {
    value: "99",
    type: "int",
    variablesReference: 0,
  });
  // a struct edit: a NEW expandable ref REPLACES the old child ref.
  assert.deepEqual(parseSetVariableResult({ value: "[1, 2]", variablesReference: 42 }), {
    value: "[1, 2]",
    type: null,
    variablesReference: 42,
  });
  // partial/absent bodies: every field degrades to null (leave the row untouched).
  assert.deepEqual(parseSetVariableResult(undefined), {
    value: null,
    type: null,
    variablesReference: null,
  });
  assert.deepEqual(parseSetVariableResult({ value: 5, variablesReference: "x" }), {
    value: null,
    type: null,
    variablesReference: null,
  });
});

test("parseThreads/parseFrames: guarded coercion; frames keep source path + column (APP-031)", () => {
  assert.deepEqual(parseThreads(undefined), []);
  assert.deepEqual(parseThreads({ threads: "x" }), []);
  assert.deepEqual(parseThreads({ threads: [null, { id: 3, name: "MainThread" }] }), [
    { id: 3, name: "MainThread" },
  ]);
  assert.deepEqual(parseFrames({}), []);
  assert.deepEqual(
    parseFrames({
      stackFrames: [
        { id: 1, name: "inner", line: 12, column: 5, source: { path: "/proj/m.py" } },
        // in-memory frame: no usable path → null (must NOT navigate, never "")
        { id: 2, name: "<string>", line: 1, source: { name: "<string>", sourceReference: 7 } },
        { id: 3, name: "empty-path", line: 2, source: { path: "" } },
      ],
    }),
    [
      { id: 1, name: "inner", line: 12, column: 5, path: "/proj/m.py" },
      { id: 2, name: "<string>", line: 1, column: 1, path: null },
      { id: 3, name: "empty-path", line: 2, column: 1, path: null },
    ],
  );
});

test("applyStopped/applyContinued: DAP all-threads semantics (APP-031)", () => {
  // allThreadsStopped marks every KNOWN id; threadId is optional
  const s1 = applyStopped(new Set(), { allThreadsStopped: true }, [1, 2, 3]);
  assert.deepEqual([...s1].sort(), [1, 2, 3]);
  const s2 = applyStopped(new Set(), { threadId: 2 }, [1, 2, 3]);
  assert.deepEqual([...s2], [2]);
  // continued with allThreadsContinued OMITTED defaults to true → everything clears
  assert.deepEqual([...applyContinued(s1, { threadId: 1 })], []);
  assert.deepEqual([...applyContinued(s1, {})], []);
  // explicit false → single-thread resume
  assert.deepEqual(
    [...applyContinued(s1, { threadId: 2, allThreadsContinued: false })].sort(),
    [1, 3],
  );
  // pickStoppedThread: event threadId wins; else first known thread; else null
  assert.equal(pickStoppedThread({ threadId: 9 }, [{ id: 1, name: "t" }]), 9);
  assert.equal(pickStoppedThread({}, [{ id: 4, name: "t" }]), 4);
  assert.equal(pickStoppedThread({}, []), null);
});

test("fetchChildren: exactly ONE variables request per node per cache", async () => {
  const log: Array<{ command: string; args: unknown }> = [];
  const req = fakeRequest(log, () => ({ variables: [{ name: "a", value: "1" }] }));
  const cache = freshCache(1);
  const first = await fetchChildren(cache, req, 12);
  const second = await fetchChildren(cache, req, 12);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], { command: "variables", args: { variablesReference: 12 } });
  assert.deepEqual(first, second);
  // a leaf (ref 0) never issues a request
  assert.deepEqual(await fetchChildren(cache, req, 0), []);
  assert.equal(log.length, 1);
});

test("fetchChildren: concurrent expands of the SAME node share one in-flight request", async () => {
  const log: Array<{ command: string; args: unknown }> = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const req = async (command: string, args?: unknown) => {
    log.push({ command, args });
    await gate;
    return { ok: true, body: { variables: [{ name: "n", value: "0" }] } };
  };
  const cache = freshCache(1);
  const p1 = fetchChildren(cache, req, 7);
  const p2 = fetchChildren(cache, req, 7);
  release?.();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(log.length, 1);
  assert.deepEqual(a, b);
});

test("cache invalidation: a NEW cache (next stop / frame switch) refetches", async () => {
  const log: Array<{ command: string; args: unknown }> = [];
  const req = fakeRequest(log, () => ({ variables: [] }));
  const stop1 = freshCache(1);
  await fetchChildren(stop1, req, 5);
  assert.equal(log.length, 1);
  // the adapter recycles reference ids on the next stopped — nothing survives
  const stop2 = freshCache(2);
  await fetchChildren(stop2, req, 5);
  assert.equal(log.length, 2);
});

test("fetchChildren: a failed request caches [] (no retry storm)", async () => {
  let calls = 0;
  const req = async () => {
    calls += 1;
    return { ok: false, error: "stale reference" };
  };
  const cache = freshCache(1);
  assert.deepEqual(await fetchChildren(cache, req, 3), []);
  assert.deepEqual(await fetchChildren(cache, req, 3), []);
  assert.equal(calls, 1);
});

test("expandable: bounded depth and ancestor-cycle guard", () => {
  assert.ok(expandable(4, 0, []));
  assert.ok(!expandable(0, 0, []), "ref 0 is a leaf");
  assert.ok(!expandable(4, MAX_EXPAND_DEPTH, []), "depth bound");
  assert.ok(!expandable(4, 1, [9, 4]), "cyclic reference in the ancestor path");
});

test("buildEvalArgs: frameId threaded when set, OMITTED (not undefined) when null", () => {
  assert.deepEqual(buildEvalArgs("x", 42, "watch"), {
    expression: "x",
    context: "watch",
    frameId: 42,
  });
  const noFrame = buildEvalArgs("x", null, "repl");
  assert.deepEqual(noFrame, { expression: "x", context: "repl" });
  assert.ok(!Object.hasOwn(noFrame, "frameId"));
});

test("evalWatches: frame-scoped watch context; one failure never aborts the others", async () => {
  const log: Array<{ command: string; args: unknown }> = [];
  const req = async (command: string, args?: unknown) => {
    log.push({ command, args });
    const expr = (args as { expression: string }).expression;
    if (expr === "boom") throw new Error("name 'boom' is not defined");
    if (expr === "bad") return { ok: false, error: "syntax error" };
    return { ok: true, body: { result: `<${expr}>`, variablesReference: expr === "obj" ? 5 : 0 } };
  };
  const out = await evalWatches(req, ["a", "boom", "bad", "obj"], 7);
  assert.deepEqual(out.a, { value: "<a>", error: false, variablesReference: 0 });
  assert.equal(out.boom?.error, true);
  assert.match(out.boom?.value ?? "", /not defined/);
  assert.deepEqual(out.bad, { value: "syntax error", error: true, variablesReference: 0 });
  assert.deepEqual(out.obj, { value: "<obj>", error: false, variablesReference: 5 });
  // every request was frame-scoped with context:"watch"
  for (const entry of log) {
    assert.equal(entry.command, "evaluate");
    assert.equal((entry.args as { context: string }).context, "watch");
    assert.equal((entry.args as { frameId: number }).frameId, 7);
  }
});

test("evalWatches: frame-switch re-evaluates against the NEW frame", async () => {
  const seen: number[] = [];
  const req = async (_c: string, args?: unknown) => {
    seen.push((args as { frameId: number }).frameId);
    return { ok: true, body: { result: "1" } };
  };
  await evalWatches(req, ["x"], 1);
  await evalWatches(req, ["x"], 2);
  assert.deepEqual(seen, [1, 2]);
});

test("evalExpression: repl context; result reference expands; errors inline", async () => {
  const log: Array<{ command: string; args: unknown }> = [];
  const req = fakeRequest(log, () => ({ result: "[1, 2, 3]", variablesReference: 11 }));
  const r = await evalExpression(req, "make_list()", 3);
  assert.deepEqual(r, { value: "[1, 2, 3]", error: false, variablesReference: 11 });
  assert.deepEqual(log[0]?.args, { expression: "make_list()", context: "repl", frameId: 3 });
  const err = await evalExpression(
    async () => {
      throw new Error("no session");
    },
    "x",
    null,
  );
  assert.equal(err.error, true);
  assert.match(err.value, /no session/);
});
