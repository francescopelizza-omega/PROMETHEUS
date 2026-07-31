/**
 * orchestrator.test.ts — the subagent fan-out decision heuristic (pure).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SUBAGENTS,
  MAX_SUBAGENTS,
  decideSubagentCount,
  orchestratorNote,
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
    /scaling 3 →/,
  );
});
