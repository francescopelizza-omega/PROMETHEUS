/**
 * terminal-floating.test.ts — the PURE tear-out (dock/undock) reducer (APP-090).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialFloatingState,
  isTornOut,
  pickActive,
  redock,
  tearOut,
  visibleSessions,
} from "./terminal-floating.js";

const SESSIONS = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("tearOut adds an id (idempotent); redock removes it", () => {
  let s = initialFloatingState();
  s = tearOut(s, "b");
  assert.deepEqual(s.tornOut, ["b"]);
  assert.equal(tearOut(s, "b"), s, "second tearOut is a no-op (same reference)");
  assert.equal(isTornOut(s, "b"), true);
  assert.equal(isTornOut(s, "a"), false);
  s = redock(s, "b");
  assert.deepEqual(s.tornOut, []);
  assert.equal(redock(s, "b"), s, "redock of a docked id is a no-op");
});

test("tearOut ignores an empty id", () => {
  const s = tearOut(initialFloatingState(), "");
  assert.deepEqual(s.tornOut, []);
});

test("visibleSessions hides torn-out sessions", () => {
  const s = tearOut(tearOut(initialFloatingState(), "a"), "c");
  assert.deepEqual(
    visibleSessions(SESSIONS, s).map((x) => x.id),
    ["b"],
  );
});

test("pickActive keeps a still-visible active; else falls back to the first visible", () => {
  const s = tearOut(initialFloatingState(), "a");
  // active "b" is still visible → kept.
  assert.equal(pickActive(SESSIONS, "b", s), "b");
  // active "a" got torn out → fall back to first visible ("b").
  assert.equal(pickActive(SESSIONS, "a", s), "b");
  // everything torn out → null.
  const all = tearOut(tearOut(s, "b"), "c");
  assert.equal(pickActive(SESSIONS, "a", all), null);
});
