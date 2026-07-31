/**
 * harden-view.test.ts — node:test unit tests for the P3 harden projector.
 *
 * Deterministic: color is disabled up front so we assert on plain text (the
 * ANSI path is covered structurally — visibleLen-style alignment is exercised
 * by render.ts's own tests). No new deps; runs under Node's native type
 * stripping (node --test src/render/harden-view.test.ts) or after a tsc emit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { HardenFinding } from "@prometheus/engine-bridge";

import { setColorEnabled } from "../render.js";
import { renderHardenFindings, renderHardenTable } from "./harden-view.js";

// Disable color for the whole suite -> stable, escape-free assertions.
setColorEnabled(false);

const SAMPLE: HardenFinding[] = [
  { severity: "ok", message: "no services bound to all interfaces", fix: "" },
  {
    severity: "warn",
    message: "macOS application firewall appears OFF",
    fix: "System Settings → Network → Firewall → On",
  },
  { severity: "info", message: "no firewall tool detected to query", fix: "" },
  {
    severity: "err",
    message: "secret file world-readable: .ssh/id_rsa (644)",
    fix: "chmod 600 ~/.ssh/id_rsa",
  },
];

test("renders every finding's message by default", () => {
  const out = renderHardenFindings(SAMPLE);
  for (const f of SAMPLE) {
    assert.ok(out.includes(f.message), `missing message: ${f.message}`);
  }
});

test("shows severity labels for each known tier", () => {
  const out = renderHardenFindings(SAMPLE);
  assert.ok(out.includes("OK"));
  assert.ok(out.includes("WARN"));
  assert.ok(out.includes("INFO"));
  assert.ok(out.includes("ERR"));
});

test("renders the fix line under actionable findings by default", () => {
  const out = renderHardenFindings(SAMPLE);
  assert.ok(out.includes("fix: System Settings → Network → Firewall → On"));
  assert.ok(out.includes("fix: chmod 600 ~/.ssh/id_rsa"));
});

test("never emits a fix line for findings with an empty fix", () => {
  const out = renderHardenFindings([{ severity: "ok", message: "all good", fix: "" }]);
  assert.ok(!out.includes("fix:"));
});

test("showFixes:false suppresses the fix lines", () => {
  const out = renderHardenFindings(SAMPLE, { showFixes: false });
  assert.ok(out.includes("macOS application firewall appears OFF"));
  assert.ok(!out.includes("fix:"));
});

test("warningsOnly:true hides ok findings but keeps warn/err/info", () => {
  const out = renderHardenFindings(SAMPLE, { warningsOnly: true });
  assert.ok(!out.includes("no services bound to all interfaces"));
  assert.ok(out.includes("macOS application firewall appears OFF"));
  assert.ok(out.includes("secret file world-readable"));
});

test("summary counts warnings AND errors", () => {
  const out = renderHardenFindings(SAMPLE);
  // 1 warn + 1 err in SAMPLE.
  assert.ok(out.includes("1 warning"));
  assert.ok(out.includes("1 error"));
  assert.ok(out.includes("to harden"));
});

test("pluralizes the warning/error counts correctly", () => {
  const out = renderHardenFindings([
    { severity: "warn", message: "a", fix: "" },
    { severity: "warn", message: "b", fix: "" },
    { severity: "err", message: "c", fix: "" },
    { severity: "err", message: "d", fix: "" },
  ]);
  assert.ok(out.includes("2 warnings"));
  assert.ok(out.includes("2 errors"));
});

test("all-clean posture reports solid, not a warning", () => {
  const out = renderHardenFindings([
    { severity: "ok", message: "no services on all interfaces", fix: "" },
    { severity: "ok", message: "FileVault ON", fix: "" },
  ]);
  assert.ok(out.includes("solid posture") || out.includes("Solid posture"));
  assert.ok(!out.includes("to harden"));
});

test("empty findings list renders a friendly note, not a blank string", () => {
  const out = renderHardenFindings([]);
  assert.ok(out.trim().length > 0);
  assert.ok(out.includes("No findings"));
});

test("warningsOnly with only ok findings reports solid posture", () => {
  const out = renderHardenFindings([{ severity: "ok", message: "all good", fix: "" }], {
    warningsOnly: true,
  });
  assert.ok(out.toLowerCase().includes("solid posture"));
});

test("unknown severity degrades to a neutral INFO tier without crashing", () => {
  const out = renderHardenFindings([
    { severity: "moonshine", message: "weird future severity", fix: "do a thing" },
  ]);
  // Unknown tier is neutral: no warn/err escalation in the summary.
  assert.ok(out.includes("weird future severity"));
  assert.ok(out.includes("INFO"));
  assert.ok(!out.includes("to harden"));
});

test("renderHardenTable produces a two-column SEVERITY/FINDING table", () => {
  const out = renderHardenTable(SAMPLE);
  assert.ok(out.includes("SEVERITY"));
  assert.ok(out.includes("FINDING"));
  assert.ok(out.includes("macOS application firewall appears OFF"));
  // no fix lines in the compact table variant
  assert.ok(!out.includes("fix:"));
});

test("renderHardenTable on empty input is a quiet single line", () => {
  const out = renderHardenTable([]);
  assert.equal(out, "No findings.");
});
