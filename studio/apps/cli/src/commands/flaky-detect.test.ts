/**
 * flaky-detect.test.ts — pure flaky classification + flaky-memory merge/parse (CLI-094).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classify,
  classifyRetry,
  isInconsistent,
  mergeFlaky,
  parseFlakyMemory,
} from "./flaky-detect.js";

test("classify: stable-pass / stable-fail / flaky / single-element edge (CLI-094)", () => {
  assert.equal(classify([true, true, true]), "stable-pass");
  assert.equal(classify([false, false]), "stable-fail");
  assert.equal(classify([true, false, true]), "flaky");
  assert.equal(classify([true]), "stable-pass"); // single-element edge
  assert.equal(classify([false]), "stable-fail");
  assert.equal(classify([]), "stable-pass"); // nothing observed failing
});

test("classifyRetry: genuine-fail (all fail), flaky (mixed), confirmed-fixed (all pass) (CLI-094)", () => {
  assert.equal(classifyRetry([false, false, false]), "genuine-fail");
  assert.equal(classifyRetry([false, true, false]), "flaky");
  assert.equal(classifyRetry([true, true, true]), "confirmed-fixed");
  assert.equal(classifyRetry([true]), "confirmed-fixed"); // single retry, passed
  assert.equal(classifyRetry([false]), "genuine-fail");
  assert.equal(classifyRetry([]), "genuine-fail"); // no evidence it recovers
});

test("isInconsistent: flaky + confirmed-fixed are inconsistent; genuine-fail is not (CLI-094)", () => {
  assert.equal(isInconsistent("flaky"), true);
  assert.equal(isInconsistent("confirmed-fixed"), true);
  assert.equal(isInconsistent("genuine-fail"), false);
});

test("mergeFlaky: accumulates count + stamps lastSeen across invocations (CLI-094)", () => {
  const t1 = mergeFlaky({}, ["a::x", "b::y"], "2026-07-18T00:00:00Z");
  assert.equal(t1["a::x"]?.count, 1);
  assert.equal(t1["a::x"]?.lastSeen, "2026-07-18T00:00:00Z");
  // a second invocation bumps the SAME test's count (visible over time), adds a new one.
  const t2 = mergeFlaky(t1, ["a::x", "c::z"], "2026-07-18T01:00:00Z");
  assert.equal(t2["a::x"]?.count, 2);
  assert.equal(t2["a::x"]?.lastSeen, "2026-07-18T01:00:00Z");
  assert.equal(t2["b::y"]?.count, 1); // untouched
  assert.equal(t2["c::z"]?.count, 1);
});

test("parseFlakyMemory: guards a corrupt/partial file → {} (never crashes the runner) (CLI-094)", () => {
  assert.deepEqual(parseFlakyMemory("not json{"), {});
  assert.deepEqual(parseFlakyMemory("[1,2,3]"), {}); // array is not a memory map
  assert.deepEqual(parseFlakyMemory('{"a::x":{"count":3,"lastSeen":"t"}}'), {
    "a::x": { count: 3, lastSeen: "t" },
  });
  // a malformed entry is dropped, a valid sibling kept.
  assert.deepEqual(parseFlakyMemory('{"bad":42,"ok":{"count":1,"lastSeen":"t"}}'), {
    ok: { count: 1, lastSeen: "t" },
  });
});
