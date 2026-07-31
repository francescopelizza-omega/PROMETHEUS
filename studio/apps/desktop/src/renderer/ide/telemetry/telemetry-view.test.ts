/**
 * telemetry-view.test.ts — node:test for the PURE telemetry presentation helpers.
 *
 * Decoupled: imports ONLY the pure module (no react, no DOM, no store), pinning the
 * byte formatting + the severity-tone thresholds the meters + the launch guard share.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test telemetry-view.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes, meterTone, sampledAgo, toneVar, usedOfTotal } from "./telemetry-view.js";

test("formatBytes: scales through the units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(32 * 1024 ** 3), "32.0 GB"); // <100 keeps a decimal
  assert.equal(formatBytes(512 * 1024 ** 3), "512 GB"); // >=100 rounds
});

test("formatBytes: unknown / negative → em-dash", () => {
  assert.equal(formatBytes(undefined), "—");
  assert.equal(formatBytes(-1), "—");
  assert.equal(formatBytes(Number.NaN), "—");
});

test("meterTone: <70 ok · 70–89 warn · >=90 danger (the guard ceiling)", () => {
  assert.equal(meterTone(0), "ok");
  assert.equal(meterTone(69.9), "ok");
  assert.equal(meterTone(70), "warn");
  assert.equal(meterTone(89.9), "warn");
  assert.equal(meterTone(90), "danger");
  assert.equal(meterTone(100), "danger");
});

test("toneVar: every tone resolves to a design token (never a bare literal)", () => {
  for (const tone of ["ok", "warn", "danger"] as const) {
    assert.match(toneVar(tone), /^var\(--/);
  }
});

test("usedOfTotal: omits the total when unknown", () => {
  assert.equal(usedOfTotal(1024, 2048), "1.0 KB / 2.0 KB");
  assert.equal(usedOfTotal(1024, undefined), "1.0 KB");
});

test("sampledAgo: seconds then minutes", () => {
  const t = 1_000_000;
  assert.equal(sampledAgo(t, t), "just now");
  assert.equal(sampledAgo(t, t + 3000), "3s ago");
  assert.equal(sampledAgo(t, t + 120_000), "2m ago");
});
