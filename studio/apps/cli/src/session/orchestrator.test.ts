/**
 * orchestrator.test.ts — the subagent fan-out decision heuristic (pure).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MAX_SPAWNS } from "@prometheus/core/agent-subagent";
import {
  DEFAULT_SUBAGENTS,
  MAX_SUBAGENTS,
  decideSubagentCount,
  orchestratorNote,
  spawnCapFor,
} from "./orchestrator.js";

test("a simple, short prompt stays at the default (3)", () => {
  assert.equal(decideSubagentCount("fix the typo in README"), DEFAULT_SUBAGENTS);
  assert.equal(decideSubagentCount("what does this do?"), DEFAULT_SUBAGENTS);
});

test("complexity signals scale the count UP (capped at MAX)", () => {
  const n = decideSubagentCount(
    "refactor the entire auth module across all services and migrate every caller",
  );
  assert.ok(n > DEFAULT_SUBAGENTS, `expected >${DEFAULT_SUBAGENTS}, got ${n}`);
  assert.ok(n <= MAX_SUBAGENTS);
});

test("a very long prompt bumps the count", () => {
  const long = `${"do this thing and that thing ".repeat(30)}`;
  assert.ok(decideSubagentCount(long) > DEFAULT_SUBAGENTS);
});

test("respects the base + ceiling", () => {
  assert.equal(decideSubagentCount("hi", 1), 1); // base 1 (no tmux) → stays 1
  assert.ok(
    decideSubagentCount(
      "audit everything everywhere across the whole entire codebase comprehensively",
      3,
      5,
    ) <= 5,
  );
});

test("orchestratorNote is empty for a simple prompt, set for a complex one", () => {
  assert.equal(orchestratorNote("rename x to y", DEFAULT_SUBAGENTS), "");
  assert.match(
    orchestratorNote(
      "audit the entire codebase across all modules and refactor everything",
      DEFAULT_SUBAGENTS,
    ),
    // was /scaling 3 →/ — the old wording claimed a fan-out that nothing performed.
    /allowing up to \d+ delegated sub-agents this turn \(was 3\)/,
  );
});

test("untouched `/agents` ⇒ the engine default — no multiplexer must not cost you delegation", () => {
  // `subagentCount` carries a DISPLAY default of 1 without tmux. Feeding that into `maxSpawns`
  // would cap delegation at one sub-agent for everyone not running a multiplexer — a silent
  // downgrade of a setting they never touched. `null` means "not set", not "set to 1".
  assert.equal(spawnCapFor("hi", null, DEFAULT_MAX_SPAWNS), DEFAULT_MAX_SPAWNS);
  const complex =
    "refactor the parser and migrate the store and update every call site and add tests";
  assert.equal(spawnCapFor(complex, null, DEFAULT_MAX_SPAWNS), DEFAULT_MAX_SPAWNS);
});

test("`/agents 2` really means at most two — LOWERING is the direction that was unreachable", () => {
  assert.equal(spawnCapFor("hi", 2, DEFAULT_MAX_SPAWNS), 2);
  assert.equal(spawnCapFor("hi", 1, DEFAULT_MAX_SPAWNS), 1);
  // a complex prompt may scale an explicit number UP, never past the ceiling…
  const complex =
    "refactor the parser and migrate the store and update every call site and add tests";
  const scaled = spawnCapFor(complex, 2, DEFAULT_MAX_SPAWNS);
  assert.ok(scaled >= 2 && scaled <= MAX_SUBAGENTS, `got ${scaled}`);
});

test("an absurd `/agents 500` is clamped to the ceiling, and 0 to one", () => {
  assert.equal(spawnCapFor("hi", 500, DEFAULT_MAX_SPAWNS), MAX_SUBAGENTS);
  assert.equal(spawnCapFor("hi", 0, DEFAULT_MAX_SPAWNS), 1);
  assert.equal(spawnCapFor("hi", -3, DEFAULT_MAX_SPAWNS), 1);
});

test("the orchestrator note describes a CAP, not a fan-out that never happened", () => {
  const complex =
    "refactor the parser and migrate the store and update every call site and add tests";
  const note = orchestratorNote(complex, 3);
  assert.notEqual(note, "");
  // It used to say "scaling 3 → 5 subagents for this task", which claimed work was being
  // parallelised. Nothing spawned anything; the number reached one consumer, this string.
  assert.doesNotMatch(note, /scaling/);
  assert.match(note, /allowing up to \d+ delegated sub-agents/);
});

test("a simple prompt still says nothing at all", () => {
  assert.equal(orchestratorNote("hi", 3), "");
});
