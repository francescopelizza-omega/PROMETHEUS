/**
 * fleet/report.test.ts — `/fleet`, the surface that is allowed to be verbose.
 *
 * Everything the bar had to abbreviate lands here, so the tests are about the things the bar
 * cannot say: which window is which, and why a meter has no ownership number.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FleetPeer } from "./heartbeat.js";
import type { FleetMeters } from "./meters.js";
import { fleetReport, fleetReportRows, fleetTable } from "./report.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const peer = (over: Partial<FleetPeer> = {}): FleetPeer => ({
  pid: 501,
  id: "s1",
  startedAt: new Date(NOW - 252_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  cwd: "/work/proj",
  model: "gemma3:27b",
  state: "working",
  self: false,
  ageMs: 0,
  stale: false,
  ...over,
});

test("this window is labelled, so a user can tell which row is theirs", () => {
  const rows = fleetReportRows([peer({ self: true })], NOW);
  assert.equal(rows[0]?.terminal, "(this window)");
});

test("`for` is the elapsed life of the window", () => {
  assert.equal(fleetReportRows([peer()], NOW)[0]?.for, "4m 12s");
});

test("a dead window reports no elapsed time rather than a number that keeps growing", () => {
  assert.equal(fleetReportRows([peer({ state: "dead" })], NOW)[0]?.for, "—");
});

test("a stale peer says so — its state stopped being refreshed", () => {
  const row = fleetReportRows([peer({ stale: true })], NOW)[0];
  assert.equal(row?.state, "working (stale)");
});

test("`needs-you` reads as words in the table", () => {
  assert.equal(fleetReportRows([peer({ state: "needs-you" })], NOW)[0]?.state, "needs you");
});

test("the table pads every column but the last", () => {
  const lines = fleetTable(fleetReportRows([peer(), peer({ pid: 70123 })], NOW));
  assert.match(lines[0] ?? "", /^ {2}# +pid +terminal/);
  // a trailing run of spaces after the cwd would be invisible padding in every copied line
  for (const l of lines) assert.equal(l, l.trimEnd());
});

const meters = (over: Partial<FleetMeters> = {}): FleetMeters => ({
  cpu: { pct: 41, oursPct: 28 },
  ram: { pct: 34, oursPct: 9, totalGb: 64, usedGb: 22, oursGb: 6 },
  accelerators: [],
  ...over,
});

test("the exact GB the bar dropped live here", () => {
  const out = fleetReport([peer()], meters(), NOW).join("\n");
  assert.match(out, /22 of 64 GB/);
  assert.match(out, /6 GB Prometheus/);
});

test("an unmeasurable split says so instead of printing 0%", () => {
  const out = fleetReport([peer()], meters({ cpu: { pct: 41 } }), NOW).join("\n");
  assert.match(out, /Prometheus share not measurable here/);
  assert.doesNotMatch(out, /0% Prometheus/);
});

test("a present-but-unreadable unit is named as exactly that", () => {
  const out = fleetReport([peer()], meters({ gpu: { pct: null } }), NOW).join("\n");
  assert.match(out, /gpu\s+present, utilization not exposed by this OS/);
});

test("the report states what `other` includes — the shared model server is not ours", () => {
  const out = fleetReport([peer()], meters(), NOW).join("\n");
  assert.match(out, /ollama/);
  assert.match(out, /processes it spawned/);
});

test("the GPU's missing ownership bar is EXPLAINED, not just absent", () => {
  const out = fleetReport([peer()], meters({ gpu: { pct: 68 } }), NOW).join("\n");
  assert.match(out, /no tool here reports per-process GPU utilization/);
});

test("an empty run directory is reported honestly, not as a blank table", () => {
  const out = fleetReport([], null, NOW).join("\n");
  assert.match(out, /heartbeat unwritable/);
});

test("a measured-but-tiny share reads `<1%`, never `0%`", () => {
  // 0.2 GB of 64 is 0.3%. Rounding it printed `0% Prometheus` on the same line as
  // `0.2 GB Prometheus` — the report contradicting itself with the exact misleading zero this
  // module exists to avoid. Observed live with two windows open.
  const out = fleetReport(
    [peer()],
    meters({ ram: { pct: 83, oursPct: 0.3, totalGb: 64, usedGb: 53.2, oursGb: 0.2 } }),
    NOW,
  ).join("\n");
  assert.match(out, /<1% Prometheus/);
  assert.doesNotMatch(out, /\b0% Prometheus/);
});

test("a genuinely zero share still reads 0% — `<1%` is not a blanket floor", () => {
  const out = fleetReport([peer()], meters({ cpu: { pct: 41, oursPct: 0 } }), NOW).join("\n");
  assert.match(out, /0% Prometheus/);
});
