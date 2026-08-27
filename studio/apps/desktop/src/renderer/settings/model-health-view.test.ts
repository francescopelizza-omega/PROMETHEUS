/**
 * model-health-view.test.ts — Settings ▸ Model Health: pure mapping/formatting helpers.
 *
 * This app has no `.test.tsx` component-render suite anywhere (grep confirms it, and the
 * node:test runner's own dev-resolver can't transform JSX — see model-health-view.ts's
 * header), so ModelHealthPage.tsx itself is exercised only by hand/e2e; what's unit-tested
 * here is the pure logic factored out of it, per this dir's own hooks-panel.test.ts precedent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { breakerPillStatus, formatRelativeTime, transportPillStatus } from "./model-health-view.js";

test("transportPillStatus: a native rejection is 'down' even if the endpoint once demonstrated it", () => {
  assert.equal(transportPillStatus({ demonstrated: true, nativeRejected: true }), "down");
  assert.equal(transportPillStatus({ demonstrated: false, nativeRejected: true }), "down");
});

test("transportPillStatus: demonstrated (and not rejected) is 'ok'", () => {
  assert.equal(transportPillStatus({ demonstrated: true, nativeRejected: false }), "ok");
});

test("transportPillStatus: never demonstrated and never rejected is 'unknown', not a false 'ok'", () => {
  assert.equal(transportPillStatus({ demonstrated: false, nativeRejected: false }), "unknown");
});

test("breakerPillStatus: closed/half-open/open map to ok/degraded/down", () => {
  assert.equal(breakerPillStatus("closed"), "ok");
  assert.equal(breakerPillStatus("half-open"), "degraded");
  assert.equal(breakerPillStatus("open"), "down");
});

test("formatRelativeTime: buckets seconds/minutes/hours/days correctly", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-08-18T12:00:00.000Z", now), "just now");
  assert.equal(formatRelativeTime("2026-08-18T11:59:53.000Z", now), "7s ago");
  assert.equal(formatRelativeTime("2026-08-18T11:58:00.000Z", now), "2m ago");
  assert.equal(formatRelativeTime("2026-08-18T09:00:00.000Z", now), "3h ago");
  assert.equal(formatRelativeTime("2026-08-15T12:00:00.000Z", now), "3d ago");
});

test("formatRelativeTime: never goes negative for a slightly-in-the-future timestamp (clock skew)", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-08-18T12:00:05.000Z", now), "just now");
});

test("formatRelativeTime: an unparsable timestamp reads as 'unknown', not NaN/garbage", () => {
  assert.equal(formatRelativeTime("not-a-date", Date.now()), "unknown");
});
