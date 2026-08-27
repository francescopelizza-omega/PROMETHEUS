/**
 * persona-view.test.ts — Settings ▸ Personas: pure mapping/formatting helpers.
 *
 * ModelHealthPage.tsx/HooksPage.tsx have no `.test.tsx` sibling anywhere in this app (the
 * node:test runner's dev-resolver can't transform JSX), so PersonasPage.tsx itself is exercised
 * only by hand/e2e; what's unit-tested here is the pure logic factored out of it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { scopeLabel, scopePillStatus, suggestedImportName } from "./persona-view.js";

test("scopeLabel: 'user' reads as the human's own persona", () => {
  assert.equal(scopeLabel("user"), "Your persona");
});

test("scopeLabel: 'project' reads as project-provided, not the user's own", () => {
  assert.equal(scopeLabel("project"), "From this project");
});

test("scopeLabel: 'imported' explicitly says read-only — the safety cue a non-technical user needs", () => {
  const label = scopeLabel("imported");
  assert.match(label, /imported/i);
  assert.match(label, /read-only/i);
});

test("scopePillStatus: 'user' is 'ok' — fully trusted, nothing narrowed", () => {
  assert.equal(scopePillStatus("user"), "ok");
});

test("scopePillStatus: 'project' is 'unknown' — informational, not a safety concern", () => {
  assert.equal(scopePillStatus("project"), "unknown");
});

test("scopePillStatus: 'imported' is 'degraded' — narrowed-and-safe, not a full 'down' alarm", () => {
  assert.equal(scopePillStatus("imported"), "degraded");
});

test("suggestedImportName: strips a trailing '.md', trims, and lowercases a plain basename", () => {
  assert.equal(suggestedImportName("Reviewer.MD"), "reviewer");
  assert.equal(suggestedImportName("  code-reviewer.md  "), "code-reviewer");
  assert.equal(suggestedImportName("snake_case_persona"), "snake_case_persona");
});

test("suggestedImportName: accepts digits/hyphen/underscore, starting with a letter or digit", () => {
  assert.equal(suggestedImportName("agent-7_build"), "agent-7_build");
  assert.equal(suggestedImportName("7agent"), "7agent");
});

test("suggestedImportName: rejects an empty or whitespace-only name", () => {
  assert.equal(suggestedImportName(""), null);
  assert.equal(suggestedImportName("   "), null);
  assert.equal(suggestedImportName(".md"), null);
});

test("suggestedImportName: rejects spaces and path-traversal-shaped input", () => {
  assert.equal(suggestedImportName("my persona"), null);
  assert.equal(suggestedImportName("../evil"), null);
  assert.equal(suggestedImportName("../../etc/passwd"), null);
});

test("suggestedImportName: rejects a flag-shaped name (would not survive a shell arg either)", () => {
  assert.equal(suggestedImportName("-rf"), null);
});

test("suggestedImportName: rejects a name over 32 characters", () => {
  const tooLong = "a".repeat(33);
  assert.equal(suggestedImportName(tooLong), null);
  const exactly32 = "a".repeat(32);
  assert.equal(suggestedImportName(exactly32), exactly32);
});

test("suggestedImportName: rejects uppercase-only-after-normalization edge case (mixed illegal chars)", () => {
  assert.equal(suggestedImportName("My Cool Persona!.md"), null);
});
