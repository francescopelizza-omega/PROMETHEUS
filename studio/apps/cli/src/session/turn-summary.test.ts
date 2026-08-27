import assert from "node:assert/strict";
import test from "node:test";

import type { agent } from "@prometheus/core";

import { turnSummaryOf } from "./turn-summary.js";

function toolUse(name: string): agent.AgentEvent {
  return { kind: "tool_use", call: { name, args: {} } };
}

test("turnSummaryOf: no tool activity falls back to the prompt", () => {
  assert.equal(turnSummaryOf("what does this file do", []), "what does this file do");
});

test("turnSummaryOf: counts writes/deletes/moves/commands, pluralized", () => {
  const events: agent.AgentEvent[] = [
    toolUse("write_file"),
    toolUse("write_file"),
    toolUse("delete_file"),
    toolUse("move_file"),
    toolUse("run_command"),
    { kind: "text", text: "done" },
    { kind: "done" },
  ];
  const s = turnSummaryOf("fix the bug", events);
  assert.match(s, /edited 2 files/);
  assert.match(s, /deleted 1 file\b/);
  assert.match(s, /moved 1 file\b/);
  assert.match(s, /ran 1 command\b/);
  assert.match(s, / — fix the bug$/);
});

test("turnSummaryOf: unrecognized tools fall into 'used <names>' (cap 3)", () => {
  const events: agent.AgentEvent[] = [
    toolUse("read_file"),
    toolUse("web_search"),
    toolUse("some_mcp_tool"),
    toolUse("another_one"),
  ];
  const s = turnSummaryOf("research something", events);
  assert.match(s, /^used read_file, web_search, some_mcp_tool — research something$/);
});

test("turnSummaryOf: long prompt is truncated via descriptorOf", () => {
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
  const s = turnSummaryOf(long, [toolUse("write_file")]);
  assert.ok(s.endsWith("…"));
});
