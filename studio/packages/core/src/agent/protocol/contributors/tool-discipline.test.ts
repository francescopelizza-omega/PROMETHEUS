/**
 * tool-discipline.test.ts — the "call the tool, don't just describe it" contributor.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_TOOL_DISCIPLINE } from "../../loop.js";
import type { PreambleCtx } from "../preamble-dispatch.js";
import { READ_ONLY_TOOL_DISCIPLINE, toolDisciplineContributor } from "./tool-discipline.js";

const ctx = (readOnly: boolean): PreambleCtx => ({
  surface: "cli",
  isSubAgent: false,
  readOnly,
  locality: "local",
  tools: [],
});

test("applies() is true regardless of ctx", () => {
  assert.equal(toolDisciplineContributor.applies(ctx(false)), true);
  assert.equal(toolDisciplineContributor.applies(ctx(true)), true);
});

test("render({readOnly:false}) returns AGENT_TOOL_DISCIPLINE verbatim, mergeTarget persona", () => {
  const unit = toolDisciplineContributor.render(ctx(false), 10_000);
  assert.equal(unit?.text, AGENT_TOOL_DISCIPLINE);
  assert.equal(unit?.mergeTarget, "persona");
});

test("render({readOnly:true}) returns the read-only variant, with no write-tool mentions", () => {
  const unit = toolDisciplineContributor.render(ctx(true), 10_000);
  assert.equal(unit?.text, READ_ONLY_TOOL_DISCIPLINE);
  assert.ok(!unit?.text.includes("propose_edit"));
  assert.ok(!unit?.text.includes("write_file"));
});
