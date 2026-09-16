/**
 * health-panel-view.test.ts — the pure System Health derivation (Reliability & Polish pack).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { HealthResult } from "../../../shared/ipc-contract.js";
import { deriveSystemHealthView, tierFromPill } from "./health-panel-view.js";

test("tierFromPill maps ready→ok, down→down, degraded/unknown→degraded (fail-closed)", () => {
  assert.equal(tierFromPill("ready"), "ok");
  assert.equal(tierFromPill("down"), "down");
  assert.equal(tierFromPill("degraded"), "degraded");
  assert.equal(tierFromPill("unknown"), "degraded");
});

test("null probe → an unknown engine row + degraded tier", () => {
  const v = deriveSystemHealthView(null, "unknown");
  assert.equal(v.tier, "degraded");
  assert.equal(v.components.length, 1);
  assert.equal(v.components[0]?.status, "unknown");
});

test("healthy probe → ok engine + ok nemesis, tier ok, score 100", () => {
  const h: HealthResult = {
    ok: true,
    version: "0.15.0",
    contractOk: true,
    nemesisPresent: true,
    problems: [],
  };
  const v = deriveSystemHealthView(h, "ready");
  assert.equal(v.tier, "ok");
  assert.equal(v.score, 100);
  assert.equal(v.components.find((c) => c.id === "engine")?.status, "ok");
  assert.equal(v.components.find((c) => c.id === "nemesis")?.status, "ok");
  assert.match(v.summary, /all systems nominal/);
});

test("contract mismatch → degraded engine row with a remediation; nemesis absent → degraded", () => {
  const h: HealthResult = {
    ok: true,
    version: "0.15.0",
    contractOk: false,
    nemesisPresent: false,
    problems: [],
  };
  const v = deriveSystemHealthView(h, "degraded");
  const engine = v.components.find((c) => c.id === "engine");
  assert.equal(engine?.status, "degraded");
  assert.ok(engine?.remediation);
  assert.match(engine?.detail ?? "", /contract mismatch/);
  assert.equal(v.components.find((c) => c.id === "nemesis")?.status, "degraded");
  assert.equal(v.tier, "degraded");
  assert.ok(v.score < 100 && v.score >= 0);
});

test("unreachable engine (down pill) → down tier, score 0, engine down", () => {
  const h: HealthResult = {
    ok: false,
    contractOk: false,
    nemesisPresent: false,
    problems: ["spawn failed"],
  };
  const v = deriveSystemHealthView(h, "down");
  assert.equal(v.tier, "down");
  assert.equal(v.score, 0);
  assert.equal(v.components.find((c) => c.id === "engine")?.status, "down");
  // engine-reported problems surface as a diagnostics row
  assert.ok(v.components.some((c) => c.id === "diagnostics"));
});

test("the diagnostics row is always present - section 2.3 lists three rows", () => {
  // It used to appear only when problems.length > 0, so a healthy machine saw two rows and
  // the summary said "all systems nominal (2)" - a count that silently became 3 when
  // something broke, and a spec'd row that could never report clean.
  const healthy = deriveSystemHealthView(
    { ok: true, contractOk: true, nemesisPresent: true, problems: [], version: "3.14.6" },
    "ready",
  );
  const ids = healthy.components.map((c) => c.id);
  assert.deepEqual(ids, ["engine", "nemesis", "diagnostics"]);
  const diag = healthy.components.find((c) => c.id === "diagnostics");
  assert.equal(diag?.status, "ok");
  assert.equal(diag?.detail, "0 issues");
  assert.match(healthy.summary, /\(3\)/, "the row count must not change with the machine");
});

test("the diagnostics row reports the real issue count when there are problems", () => {
  const sick = deriveSystemHealthView(
    {
      ok: true,
      contractOk: true,
      nemesisPresent: true,
      problems: ["node-pty not compiled"],
      version: "3.14.6",
    },
    "degraded",
  );
  const diag = sick.components.find((c) => c.id === "diagnostics");
  assert.equal(diag?.status, "degraded");
  assert.equal(diag?.detail, "1 issue");
  assert.equal(sick.components.length, 3, "still three rows");
});
