/**
 * preamble.test.ts — the hidden cooperation preamble (orchestrator + subagent variants).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPreamble } from "./preamble.js";

const roster = [
  { name: "lead", role: "orchestrate" },
  { name: "api", role: "backend" },
  { name: "ui", role: "frontend" },
];

test("orchestrator preamble: forces delegation + teaches the protocol + carries the goal", () => {
  const p = buildPreamble({
    self: "lead",
    role: "orchestrate",
    orchestrator: "lead",
    isOrchestrator: true,
    roster,
    goal: "build a login feature",
  });
  assert.match(p, /ORCHESTRATOR/);
  assert.match(p, /Do NOT try to do/); // forces cooperation
  assert.match(p, /prom-msg <name> "<your message>"/); // protocol
  assert.match(p, /prom-msg done/);
  assert.match(p, /api \(backend\)/); // roster
  assert.match(p, /build a login feature/); // goal
  assert.doesNotMatch(p, /You are "lead", the .* specialist/); // not the subagent variant
});

test("subagent preamble: names the orchestrator + peers + the report-up command", () => {
  const p = buildPreamble({
    self: "api",
    role: "backend",
    orchestrator: "lead",
    isOrchestrator: false,
    roster,
  });
  assert.match(p, /You are "api", the backend specialist/);
  assert.match(p, /orchestrator is "lead"/);
  assert.match(p, /ui \(frontend\)/); // a peer
  assert.match(p, /lead \(orchestrate\)/); // the orchestrator is in api's roster
  assert.match(p, /prom-msg lead "<your result>"/); // report up
  assert.match(p, /\[from <name>\]/); // incoming format explained
});

test("custom helper name is honored", () => {
  const p = buildPreamble({
    self: "a",
    role: "r",
    orchestrator: "a",
    isOrchestrator: true,
    roster: [],
    helper: "swarm-send",
  });
  assert.match(p, /swarm-send <name>/);
  assert.doesNotMatch(p, /prom-msg/);
});

test("self is excluded from the peer roster", () => {
  const p = buildPreamble({
    self: "api",
    role: "backend",
    orchestrator: "lead",
    isOrchestrator: false,
    roster,
  });
  // 'api (backend)' should NOT appear as a teammate of itself
  assert.doesNotMatch(p, /- api \(backend\)/);
});
