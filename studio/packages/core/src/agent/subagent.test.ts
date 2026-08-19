/**
 * subagent.test.ts — delegation, and the four ways it must refuse.
 *
 * `runAgentTurn` holds no module state, which is exactly what makes it re-entrant AND exactly
 * what makes an unguarded `spawn_agent` recurse until the token budget is gone. Nothing in the
 * loop would stop it. So every test here is about a refusal or a narrowing; the happy path is
 * the easy part.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelRef } from "../agents/types.js";
import type { AgentEvent } from "./events.js";
import type { AgentTuning, LLMClient, LlmTurn, Thread, ToolRunner } from "./loop.js";
import { defaultTuning, runAgentTurn } from "./loop.js";
import {
  DEFAULT_CHILD_ROUNDS,
  SPAWN_AGENT_TOOL,
  canSpawn,
  childTuning,
  initialBudget,
  isSubagentRole,
  runSubagent,
} from "./subagent.js";
import type { ToolDef } from "./tools.js";

const MODEL: ModelRef = { provider: "local", modelId: "m" };

const READ: ToolDef = {
  name: "read_file",
  title: "",
  description: "",
  schema: {},
  annotations: { readOnlyHint: true },
  toArgv: () => [],
};
const WRITE: ToolDef = {
  name: "write_file",
  title: "",
  description: "",
  schema: {},
  annotations: { destructiveHint: true },
  toArgv: () => [],
};
const EXPOSED = [READ, WRITE, SPAWN_AGENT_TOOL];

function parent(over: Partial<AgentTuning> = {}): AgentTuning {
  return {
    ...defaultTuning(MODEL),
    tools: { enabled: true, allow: [], deny: [], extra: EXPOSED },
    ...over,
  };
}

/* ── the guards ─────────────────────────────────────────────────────────────*/

test("a sub-agent cannot spawn another", () => {
  // One level of delegation is the useful case; a tree is how a runaway burns the budget.
  const child = initialBudget({ depth: 1 });
  const d = canSpawn(child);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.match(d.reason, /cannot spawn another/);
});

test("the spawn budget is per TURN, not per parent", () => {
  // Per-parent counting lets ten sequential spawns each start fresh — the same runaway with
  // extra steps.
  const b = initialBudget({ maxSpawns: 2 });
  assert.equal(canSpawn(b).allowed, true);
  b.spawned = 2;
  const d = canSpawn(b);
  assert.equal(d.allowed, false);
  if (!d.allowed) assert.match(d.reason, /already spawned 2/);
});

test("a refusal tells the model what to do instead", () => {
  const d = canSpawn(initialBudget({ depth: 1 }));
  if (!d.allowed) assert.match(d.reason, /do this part of the work yourself/);
});

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("depth is a REAL backstop: a nested spawn is refused even if a child's tools still exposed spawn_agent", async () => {
  // Mirrors the CLI's and desktop's `spawnSubagent`/`spawn` wiring: ONE shared budget across
  // the whole tree, `depth` incremented for exactly the duration of a live child call and
  // decremented once it returns (see agent-runtime.ts's `spawnSubagent` and run-controller.ts's
  // `spawn`). `childTuning` denies `spawn_agent` in practice, which is what actually stops
  // recursion today — this proves the guard still holds even if that single deny-list entry
  // were ever bypassed or refactored away, by deliberately NOT applying `childTuning` here.
  const budget = initialBudget();
  const refusals: string[] = [];
  let calls = 0;
  const llm: LLMClient = {
    turn(): AsyncIterable<LlmTurn> {
      calls += 1;
      const n = calls;
      return (async function* () {
        // the root's first call, AND the child's first call, both try to spawn again.
        if (n <= 2) {
          yield {
            kind: "tool_call",
            call: { name: "spawn_agent", args: { task: "nested", role: "explore" } },
          };
          return;
        }
        yield { kind: "final", text: "done" };
      })();
    },
  };
  const runTool: ToolRunner = async (_tool, args) => {
    const decision = canSpawn(budget);
    if (!decision.allowed) {
      refusals.push(decision.reason);
      return { ok: false, summary: decision.reason };
    }
    budget.spawned += 1;
    budget.depth += 1;
    try {
      const childThread: Thread = { messages: [{ role: "user", content: String(args.task) }] };
      const events = await collect(
        runAgentTurn(childThread, parent(), { llm, runTool, confirm: () => true }),
      );
      const text = events
        .filter((e) => e.kind === "text")
        .map((e) => (e.kind === "text" ? e.text : ""))
        .join("");
      return { ok: true, summary: text || "(no answer)" };
    } finally {
      budget.depth -= 1;
    }
  };

  await collect(
    runAgentTurn({ messages: [{ role: "user", content: "go" }] }, parent(), {
      llm,
      runTool,
      confirm: () => true,
    }),
  );

  assert.equal(refusals.length, 1, "the nested spawn should have been refused exactly once");
  assert.match(refusals[0] ?? "", /cannot spawn another/);
  assert.equal(budget.depth, 0, "depth must unwind back to 0 once every spawn has returned");
});

/* ── privilege can only narrow ──────────────────────────────────────────────*/

test("a read-only role denies every non-readOnly tool", () => {
  const t = childTuning(parent(), "explore", "find X", EXPOSED);
  assert.ok(t.tools.deny.includes("write_file"));
  assert.equal(t.tools.deny.includes("read_file"), false);
});

test("EVERY role denies spawn_agent — the child is removed from the temptation", () => {
  for (const role of ["explore", "scout", "build"] as const) {
    const t = childTuning(parent(), role, "task", EXPOSED);
    assert.ok(t.tools.deny.includes("spawn_agent"), `${role} kept spawn_agent`);
  }
});

test("the parent's deny list is INHERITED, never dropped", () => {
  // Otherwise "ask the sub-agent to do it" launders a denial the user set.
  const p = parent({ tools: { enabled: true, allow: [], deny: ["run_command"], extra: EXPOSED } });
  const t = childTuning(p, "build", "task", EXPOSED);
  assert.ok(t.tools.deny.includes("run_command"));
});

test("a build child never inherits blanket auto-approval", () => {
  // `yes` on the parent is a decision the human made about the parent's visible work, not a
  // standing grant for work they will not see.
  const t = childTuning(parent({ yes: true }), "build", "task", EXPOSED);
  assert.equal(t.yes, false);
});

test("gateMode is inherited exactly — a child cannot loosen the gate", () => {
  for (const gateMode of ["enforce", "warn", "off"] as const) {
    assert.equal(childTuning(parent({ gateMode }), "build", "t", EXPOSED).gateMode, gateMode);
  }
});

test("a child's round budget is capped even when it asks for more", () => {
  assert.equal(
    childTuning(parent(), "explore", "t", EXPOSED, 9999).maxRounds,
    DEFAULT_CHILD_ROUNDS,
  );
  assert.equal(childTuning(parent(), "explore", "t", EXPOSED, 3).maxRounds, 3);
  assert.equal(childTuning(parent(), "explore", "t", EXPOSED, 0).maxRounds, 1);
});

test("the task becomes the child's instruction, and the role its persona", () => {
  const t = childTuning(parent(), "scout", "where is parseFoo defined", EXPOSED);
  assert.match(t.systemPrompt, /Scout sub-agent/);
  assert.match(t.systemPrompt, /where is parseFoo defined/);
});

/* ── running one ────────────────────────────────────────────────────────────*/

/** A fake turn: emits some tool activity, then an answer. */
function fakeTurn(events: AgentEvent[]) {
  return async function* (): AsyncIterable<AgentEvent> {
    for (const e of events) yield e;
  };
}

test("only the FINAL TEXT crosses back — the child's transcript does not", () => {
  // The whole benefit of delegating is that twenty tool results stay out of the parent.
  return runSubagent(
    fakeTurn([
      { kind: "tool_use", call: { name: "read_file", args: {} } },
      {
        kind: "tool_result",
        call: { name: "read_file", args: {} },
        ok: true,
        summary: "1000 lines of noise",
      },
      { kind: "text", text: "It is defined in a.ts:42." },
      { kind: "done" },
    ]),
    parent(),
    "find it",
    { llm: { turn: async function* () {} }, runTool: async () => ({ ok: true, summary: "" }) },
  ).then((out) => {
    assert.equal(out.ok, true);
    assert.equal(out.text, "It is defined in a.ts:42.");
    assert.doesNotMatch(out.text, /1000 lines of noise/);
    assert.equal(out.toolCalls, 1);
  });
});

test("a child that answered NOTHING is a failure, not an empty finding", async () => {
  // An empty delegation result silently becomes "the subtask found nothing" — a different,
  // usually wrong claim.
  const out = await runSubagent(fakeTurn([{ kind: "done" }]), parent(), "t", {
    llm: { turn: async function* () {} },
    runTool: async () => ({ ok: true, summary: "" }),
  });
  assert.equal(out.ok, false);
  assert.match(out.text, /returned no answer/);
});

/* ── the tool ───────────────────────────────────────────────────────────────*/

test("spawn_agent is NOT readOnly — a build child can change the machine", () => {
  assert.notEqual(SPAWN_AGENT_TOOL.annotations.readOnlyHint, true);
  assert.equal(SPAWN_AGENT_TOOL.schema.task?.required, true);
  assert.equal(SPAWN_AGENT_TOOL.schema.role?.type, "enum");
  assert.deepEqual(SPAWN_AGENT_TOOL.schema.role?.enum, ["explore", "scout", "plan", "build"]);
  assert.throws(() => SPAWN_AGENT_TOOL.toArgv({}), /host runtime/);
});

test("the description warns the task must stand alone", () => {
  // A sub-agent cannot see the parent conversation; a model that assumes otherwise sends
  // "now do the other one" and gets nonsense back.
  assert.match(SPAWN_AGENT_TOOL.description, /cannot see this conversation/);
});

test("only the four known roles are accepted", () => {
  for (const r of ["explore", "scout", "plan", "build"]) assert.equal(isSubagentRole(r), true);
  for (const r of ["admin", "", null, 7, "BUILD"]) assert.equal(isSubagentRole(r), false);
});

/* ── plan mode: the posture is narrowed like everything else ─────────────────*/

test("childTuning: a read-only role pins permissionMode to plan even from a wide-open parent", () => {
  // Prevents the shape where `spawn_agent {role:"explore"}` inherits `bypassPermissions` and
  // the child's mutations auto-run — delegation must never be a way to WIDEN a posture.
  const parent: AgentTuning = { ...defaultTuning(MODEL), permissionMode: "bypassPermissions" };
  for (const role of ["explore", "scout", "plan"] as const) {
    const child = childTuning(parent, role, "look around", EXPOSED);
    assert.equal(child.permissionMode, "plan", `${role} must be read-only`);
  }
});

test("childTuning: a build child INHERITS a plan parent's mode — delegation cannot launder it", () => {
  // The whole point: an agent the user put in plan mode must not be able to obtain a writable
  // agent by spawning one. `build` is writable only when the PARENT already was.
  const planned: AgentTuning = { ...defaultTuning(MODEL), permissionMode: "plan" };
  assert.equal(childTuning(planned, "build", "do it", EXPOSED).permissionMode, "plan");
  const open: AgentTuning = { ...defaultTuning(MODEL), permissionMode: "default" };
  assert.equal(childTuning(open, "build", "do it", EXPOSED).permissionMode, "default");
});

test("childTuning: an undefined parent mode stays undefined for a build child (no invented posture)", () => {
  // A host that never set a mode must keep the pre-existing behaviour exactly — inventing
  // `default` here would silently start denying nothing, but it would also start CLAIMING a
  // posture the host never chose, which is how the two mode systems diverged the first time.
  const child = childTuning(defaultTuning(MODEL), "build", "do it", EXPOSED);
  assert.equal(child.permissionMode, undefined);
});

test("the plan role is read-only and says so in its system prompt", () => {
  const child = childTuning(defaultTuning(MODEL), "plan", "design the migration", EXPOSED);
  assert.match(child.systemPrompt, /READ-ONLY/);
  assert.match(child.systemPrompt, /Plan sub-agent/);
  // and its deny list strips the writable tool, exactly as explore/scout do.
  assert.ok(child.tools.deny.includes("write_file"));
});
