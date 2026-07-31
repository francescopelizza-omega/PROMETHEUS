/**
 * health.test.ts — system-health aggregation + adapters (Reliability & Polish pack).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type HealthComponent,
  aggregateHealth,
  boolComponent,
  breakerStatus,
  engineComponent,
  serveComponent,
  threatDbComponent,
} from "./index.js";

test("aggregateHealth: all ok → tier ok, score 100", () => {
  const cs: HealthComponent[] = [
    { id: "a", label: "A", status: "ok" },
    { id: "b", label: "B", status: "ok" },
  ];
  const h = aggregateHealth(cs);
  assert.equal(h.tier, "ok");
  assert.equal(h.score, 100);
  assert.match(h.summary, /all systems nominal/);
});

test("aggregateHealth: any down → tier down; score is the weighted average", () => {
  const h = aggregateHealth([
    { id: "a", label: "A", status: "ok" }, // 100
    { id: "b", label: "B", status: "down" }, // 0
  ]);
  assert.equal(h.tier, "down");
  assert.equal(h.score, 50);
  assert.match(h.summary, /1\/2 need attention: B/);
});

test("aggregateHealth: degraded/unknown (no down) → tier degraded (fail-closed, unknown≠ok)", () => {
  assert.equal(aggregateHealth([{ id: "a", label: "A", status: "degraded" }]).tier, "degraded");
  assert.equal(aggregateHealth([{ id: "a", label: "A", status: "unknown" }]).tier, "degraded");
  assert.equal(aggregateHealth([]).tier, "degraded", "no components reporting → degraded");
});

test("engineComponent maps probe → ok / degraded(contract) / down(unreachable)", () => {
  assert.equal(engineComponent({ ok: true, contractOk: true, version: "0.15.0" }).status, "ok");
  assert.equal(
    engineComponent({ ok: true, contractOk: false, version: "0.15.0" }).status,
    "degraded",
  );
  const down = engineComponent({ ok: false, contractOk: false });
  assert.equal(down.status, "down");
  assert.ok(down.remediation);
});

test("serveComponent counts running/errored", () => {
  assert.equal(serveComponent([]).status, "ok");
  assert.equal(serveComponent(["running", "running"]).status, "ok");
  assert.equal(serveComponent(["running", "starting"]).status, "degraded");
  const errored = serveComponent(["running", "errored"]);
  assert.equal(errored.status, "down");
  assert.ok(errored.remediation);
  assert.match(errored.detail ?? "", /errored/);
});

test("breakerStatus maps open→down, half-open→degraded, closed→ok", () => {
  assert.equal(breakerStatus("open"), "down");
  assert.equal(breakerStatus("half-open"), "degraded");
  assert.equal(breakerStatus("closed"), "ok");
});

test("threatDbComponent: unseeded → degraded+hint; stale → degraded; fresh → ok", () => {
  assert.equal(threatDbComponent(false, undefined).status, "degraded");
  assert.ok(threatDbComponent(false, undefined).remediation);
  assert.equal(threatDbComponent(true, 30, 7).status, "degraded");
  assert.equal(threatDbComponent(true, 1, 7).status, "ok");
});

test("boolComponent: false → down (or degraded with softFail) + remediation only when bad", () => {
  assert.equal(boolComponent("x", "X", true).status, "ok");
  assert.equal(boolComponent("x", "X", false).status, "down");
  assert.equal(boolComponent("x", "X", false, { softFail: true }).status, "degraded");
  assert.equal(boolComponent("x", "X", true, { remediation: "fix" }).remediation, undefined);
});
