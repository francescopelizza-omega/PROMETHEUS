/**
 * topology.test.ts — topology validation + tree queries.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type OrchestrationTopology,
  ancestryOf,
  childrenOf,
  depthOf,
  getAgent,
  normalizeTopology,
  parentOf,
  peersOf,
  validateTopology,
} from "./topology.js";

const T: OrchestrationTopology = normalizeTopology({
  orchestrator: "lead",
  agents: [
    {
      name: "lead",
      backend: { kind: "cli", service: "claude" },
      role: "orchestrate",
      children: ["api", "ui"],
    },
    {
      name: "api",
      backend: { kind: "cli", service: "codex" },
      role: "backend",
      children: ["dbtests"],
    },
    { name: "ui", backend: { kind: "cli", service: "gemini" }, role: "frontend" },
    { name: "dbtests", backend: { kind: "local", model: "qwen" }, role: "tests" },
  ],
});

test("valid tree passes validation", () => {
  const v = validateTopology(T);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

test("tree queries: children / parent / ancestry / depth", () => {
  assert.deepEqual(
    childrenOf(T, "lead").map((a) => a.name),
    ["api", "ui"],
  );
  assert.equal(parentOf(T, "api"), "lead");
  assert.equal(parentOf(T, "lead"), undefined);
  assert.deepEqual(ancestryOf(T, "dbtests"), ["dbtests", "api", "lead"]);
  assert.equal(depthOf(T, "lead"), 0);
  assert.equal(depthOf(T, "dbtests"), 2);
  assert.equal(getAgent(T, "ui")?.role, "frontend");
});

test("peersOf includes siblings, parent, and own children", () => {
  // api's peers: sibling ui, parent lead, child dbtests
  assert.deepEqual(peersOf(T, "api").sort(), ["dbtests", "lead", "ui"]);
  // lead's peers: its children
  assert.deepEqual(peersOf(T, "lead").sort(), ["api", "ui"]);
});

test("rejects duplicate names", () => {
  const v = validateTopology(
    normalizeTopology({
      orchestrator: "a",
      agents: [
        { name: "a", backend: { kind: "fake" }, role: "r", children: ["b"] },
        { name: "b", backend: { kind: "fake" }, role: "r" },
        { name: "b", backend: { kind: "fake" }, role: "r" },
      ],
    }),
  );
  assert.ok(v.errors.some((e) => /duplicate agent name "b"/.test(e)));
});

test("rejects an unknown orchestrator + unknown child + two parents", () => {
  const v = validateTopology(
    normalizeTopology({
      orchestrator: "ghost",
      agents: [
        { name: "a", backend: { kind: "fake" }, role: "r", children: ["c", "x"] },
        { name: "b", backend: { kind: "fake" }, role: "r", children: ["c"] },
        { name: "c", backend: { kind: "fake" }, role: "r" },
      ],
    }),
  );
  assert.ok(v.errors.some((e) => /orchestrator "ghost" is not in agents/.test(e)));
  assert.ok(v.errors.some((e) => /unknown child "x"/.test(e)));
  assert.ok(v.errors.some((e) => /two parents/.test(e)));
});

test("rejects an unreachable agent + a cli backend missing its service", () => {
  const v = validateTopology(
    normalizeTopology({
      orchestrator: "a",
      agents: [
        { name: "a", backend: { kind: "fake" }, role: "r" },
        { name: "orphan", backend: { kind: "cli" }, role: "r" },
      ],
    }),
  );
  assert.ok(v.errors.some((e) => /unreachable/.test(e)));
  assert.ok(v.errors.some((e) => /names no service/.test(e)));
});

test("rejects an invalid (address-unsafe) agent name", () => {
  const v = validateTopology(
    normalizeTopology({
      orchestrator: "ok",
      agents: [
        { name: "ok", backend: { kind: "fake" }, role: "r", children: ["1bad"] },
        { name: "1bad", backend: { kind: "fake" }, role: "r" }, // starts with a digit
      ],
    }),
  );
  assert.ok(v.errors.some((e) => /invalid agent name "1bad"/.test(e)));
});

test("normalizeTopology fills version + default limits", () => {
  const t = normalizeTopology({ orchestrator: "x", agents: [] });
  assert.equal(t.version, 1);
  assert.equal(t.limits.maxDepth, 3);
  assert.equal(t.limits.maxAgents, 24);
});
