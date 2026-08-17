/**
 * tool-parity.test.ts — Phase 6's acceptance criterion: CLI and GUI expose an IDENTICAL
 * tool list.
 *
 * This suite exists because "keep the two surfaces in sync by being careful" is exactly what
 * produced the split it now guards. Before Phase 6, Studio declared its own four ToolDefs and
 * the CLI exposed core's nineteen. They had drifted on every axis that matters:
 *
 *   - `run_command` took `{command, cwd}` in Studio and `{command, cwd, timeoutSeconds, mode}`
 *     in the CLI;
 *   - Studio annotated it `destructiveHint` (so A6/A7 auto-approved it) while core classifies
 *     it `command` (A4);
 *   - Studio's description said "run a shell command" — and it meant it: `ide:exec` spawned
 *     `shell -c <command>` behind an 11-pattern regex denylist, while the CLI parsed the line
 *     and spawned each program directly through six structural layers.
 *
 * The weaker surface was the GUI, which is the one most people use. A drift test is cheap;
 * discovering the drift the way it was discovered is not.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BROWSER_TOOLS,
  SYSTEM_FS_WRITE_TOOLS,
  SYSTEM_MEMORY_TOOLS,
  SYSTEM_TOOLS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  isHostDispatchTool,
} from "@prometheus/core/agent-system";
import { TODO_TOOLS } from "@prometheus/core/agent-todo";

import { ENGINE_VERBS, exposedTools, isEngineVerb } from "@prometheus/core/agent-tools";

import { AGENT_PANE_ALLOW, EDITOR_TOOLS } from "./core-agent.js";

test("Studio exposes core's system tools — the same OBJECTS, not copies", () => {
  // Identity per tool, not of the array: the pane's set is now SYSTEM_TOOLS plus tools that are
  // dispatched in the renderer (they never reach main's system-tool channel). A structural
  // comparison would pass against a duplicated literal, which is the failure this pins against.
  for (const t of SYSTEM_TOOLS) {
    assert.ok(EDITOR_TOOLS.includes(t), `${t.name} is not core's own object`);
  }
});

test("the pane's allow-list is core's system tools plus the renderer-side edit tools", () => {
  assert.deepEqual(AGENT_PANE_ALLOW, [
    ...ENGINE_VERBS,
    ...SYSTEM_TOOLS.map((t) => t.name),
    ...SYSTEM_FS_WRITE_TOOLS.map((t) => t.name),
    ...SYSTEM_MEMORY_TOOLS.map((t) => t.name),
    ...TODO_TOOLS.map((t) => t.name),
    "propose_edit",
    "write_file",
    WEB_FETCH_TOOL.name,
    WEB_SEARCH_TOOL.name,
    ...BROWSER_TOOLS.map((t) => t.name),
    "spawn_agent",
    "question",
    "apply_patch",
    "notebook_edit",
  ]);
});

test("every ALLOWED name actually resolves to a tool the model is shown", () => {
  // Adding a tool costs FOUR guard edits across three processes, and two fail SILENTLY: a name
  // in the allow-list that resolves to nothing is simply absent from the model's list, while a
  // tool the model IS shown but that no guard admits comes back "not available in the editor".
  // Asserted through core's own resolver, because an allowed name may come from the BASE
  // catalogue (propose_edit, write_file) or from `extra` (apply_patch) — checking `extra` alone
  // is what made the first version of this test wrong.
  const resolved = exposedTools({
    enabled: true,
    allow: [...AGENT_PANE_ALLOW],
    deny: [],
    extra: [...EDITOR_TOOLS],
  }).map((t) => t.name);
  for (const name of AGENT_PANE_ALLOW) {
    assert.ok(resolved.includes(name), `${name} is allowed but resolves to no tool`);
  }
});

test("every system tool the GUI offers is one the CLI offers, and vice versa", () => {
  // The CLI's list IS `SYSTEM_TOOLS` (wired at cli-profiles/profile.ts as `tools.extra`), so
  // this asserts the property that matters: one source, no second declaration anywhere.
  const gui = [...EDITOR_TOOLS]
    .map((t) => t.name)
    .filter((n) => SYSTEM_TOOLS.some((s) => s.name === n))
    .sort();
  const cli = [...SYSTEM_TOOLS].map((t) => t.name).sort();
  assert.deepEqual(gui, cli);
});

test("run_command's schema is the shared one — the drift that mattered most", () => {
  const rc = SYSTEM_TOOLS.find((t) => t.name === "run_command");
  assert.ok(rc, "run_command must be in the shared set");
  // Studio's own def had neither of these, so a model on the GUI could not background a
  // long install or bound a runaway build — the same model, the same prompt, less capability.
  assert.ok("timeoutSeconds" in rc.schema, "the GUI used to lack a timeout knob");
  assert.ok("mode" in rc.schema, "the GUI used to lack stream/background modes");
});

test("run_command carries NO destructiveHint — it classifies by name, not annotation", () => {
  // Studio annotated it `destructiveHint`, which classifies as `destructive` and therefore
  // AUTO-APPROVES at A6/A7. Core has `classifyAuth` special-case the name to `command` (A4),
  // so the tier the parser computes is what decides. An annotation here would silently
  // re-raise the GUI's auto-approval two rungs.
  const rc = SYSTEM_TOOLS.find((t) => t.name === "run_command");
  assert.deepEqual(rc?.annotations, {});
});

test("the elevated proposal is reachable in the GUI too", () => {
  // It never auto-approves at any level, so before Phase 6's confirm change the GUI would
  // have denied it every time — present in the list, permanently unusable.
  assert.ok(AGENT_PANE_ALLOW.includes("propose_elevated"));
});

/** Tools the RENDERER dispatches itself; everything else must survive the trip to main. */
const RENDERER_LOCAL = new Set([
  "propose_edit",
  "write_file",
  "apply_patch",
  // A nested turn and a question card are both answered inside the renderer: one re-enters the
  // same loop with the same tool runner, the other suspends on a card the user types into.
  "spawn_agent",
  "question",
  // The .ipynb pipeline (parseIpynb → mutate → serializeIpynb, via the notebook store) lives
  // in the renderer, so main's `agent:systemTool` guard would reject the name outright.
  "notebook_edit",
  ...TODO_TOOLS.map((t) => t.name),
]);

test("every allowed tool the renderer forwards is one main will actually run", () => {
  // Engine verbs travel their OWN channel (`agent:engineTool`), guarded by core's catalogue
  // in main rather than by `isHostDispatchTool`, so they are excluded from this check.
  // THE silent failure. The renderer checks membership before the IPC call and main checks it
  // again before running; they were two hand-kept copies of the same fact, and they diverged
  // the moment one was widened — main learned the Tier-W mutators, the renderer did not. The
  // model was shown `delete_file`, the human approved it, and the renderer refused it as "not
  // available in the editor". Both now consult `isHostDispatchTool`, and this pins that.
  for (const name of AGENT_PANE_ALLOW) {
    if (RENDERER_LOCAL.has(name) || isEngineVerb(name)) continue;
    assert.ok(isHostDispatchTool(name), `${name} is offered but no host will dispatch it`);
  }
});

test("the renderer-local tools are NOT in the host dispatch list", () => {
  // The converse: a tool answered in the renderer must not also be claimed by main, or which
  // implementation runs depends on which check happens to come first.
  for (const name of RENDERER_LOCAL) {
    assert.equal(isHostDispatchTool(name), false, `${name} is claimed by both sides`);
  }
});

test("the pane can reach the network — it could not, at all", () => {
  // No web tool meant a pasted link was unreadable and nothing could be looked up: the same
  // model, the same prompt, strictly less capability than the CLI.
  assert.ok(AGENT_PANE_ALLOW.includes("web_fetch"));
  assert.ok(AGENT_PANE_ALLOW.includes("web_search"));
});

/* ── the seams the pane must actually FILL IN ────────────────────────────────*/

test("the pane supplies the ide bridge and the workspace root to every run", () => {
  // THE silent failure of this whole surface. `AgentLoopDeps.ide` and `.root` are optional so a
  // headless harness degrades instead of throwing — and the pane never filled them in, so
  // `systemTool` resolved to undefined and every AUTO-approved tool (at A1 "read freely", every
  // read) came back `"read_file" is unavailable in this environment`. Only the tools a human
  // clicked Run on worked, because the task card calls the bridge directly. Asserted as source
  // text because the alternative is mounting the whole pane.
  const src = readFileSync(new URL("./AgentPane.tsx", import.meta.url), "utf8");
  const deps = src.slice(src.indexOf("const deps: Omit<AgentLoopDeps"));
  assert.match(deps.slice(0, 3000), /\n\s+root,/, "the workspace root is not passed to the run");
  assert.match(deps.slice(0, 3000), /\n\s+ide: \{/, "the ide bridge is not passed to the run");
  assert.match(deps.slice(0, 3000), /mcp: \{/, "the MCP bridge is not passed to the run");
});
