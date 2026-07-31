/**
 * rightrail-view.test.ts — the pure Inspector-payload serializer (APP-001).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { safeInspectorJson } from "./rightrail-view.js";

test("safeInspectorJson: plain object round-trips as pretty JSON", () => {
  const out = safeInspectorJson({ activity: "home", branch: null });
  assert.equal(out, JSON.stringify({ activity: "home", branch: null }, null, 2));
});

test("safeInspectorJson: a circular reference never throws — returns an error string", () => {
  const obj: Record<string, unknown> = { a: 1 };
  obj.self = obj;
  const out = safeInspectorJson(obj);
  assert.match(out, /^<failed to serialize:/);
});

test("safeInspectorJson: oversized payloads are truncated with a visible marker", () => {
  const big = { blob: "x".repeat(30_000) };
  const out = safeInspectorJson(big);
  assert.ok(out.length < 30_000);
  assert.match(out, /truncated \(\d+ chars total\)$/);
});

test('safeInspectorJson: null passes through as the literal "null"', () => {
  assert.equal(safeInspectorJson(null), "null");
});
