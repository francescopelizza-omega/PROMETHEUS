/**
 * agent/subagent.ts — delegate a subtask to a scoped worker.
 *
 * Why not reuse what is already here: there are two other agent stacks in this repo and
 * NEITHER fits. `agents/orchestrator.ts` is a complete ReAct loop whose `ToolCall` is
 * `{ref}` where the live loop's is `{name}` — not assignable, and its only callers are its
 * own tests. `orchestration/coordinator.ts` genuinely recurses under a budget, but its agents
 * are text-only: they get no tools at all, which is the entire point of delegating. The loop
 * that actually runs is `runAgentTurn`, and it is already re-entrant because it holds no
 * module state. So this is a thin, guarded re-entry into THAT, not a fourth stack.
 *
 * WHY DELEGATE AT ALL: a subtask like "find every caller of X" costs twenty tool results, and
 * the parent only needs the answer. Running it in a child thread keeps those twenty results
 * out of the parent's context — the parent gets a paragraph instead of a transcript. That is
 * the whole benefit, and it is why only the FINAL TEXT comes back.
 *
 * THE GUARDS ARE THE DESIGN. `runAgentTurn` holds no state, which is exactly why a naive
 * `spawn_agent` recurses forever: nothing anywhere would stop it. So:
 *
 *   - **depth** — a sub-agent may not spawn (default `maxDepth: 1`). One level of delegation
 *     is the useful case; a tree is how a runaway burns a token budget in ninety seconds.
 *   - **spawn budget** — a total across the whole turn, not per-parent, so ten sequential
 *     spawns are bounded too.
 *   - **privilege can only NARROW** — the child inherits the parent's `gateMode`, `yes` and
 *     tool policy, and may restrict them further. It may never widen them. Delegation must
 *     not become a permission-laundering path: "the sub-agent did it" cannot be a way to
 *     reach a tool the parent was denied.
 *
 * PURE: no node, no IO. The runner is injected, so the child's tools go through the SAME
 * broker, gate and confirm as the parent's.
 */

import type { AgentEvent } from "./events.js";
import type { AgentTuning, AgentTurnDeps, Thread } from "./loop.js";
import type { PermissionModeId } from "./permission-modes.js";
import type { ToolDef } from "./tools.js";

/** How deep delegation may go. 1 = the primary may spawn; its children may not. */
export const DEFAULT_MAX_DEPTH = 1;
/** How many children one turn may spawn in total. */
export const DEFAULT_MAX_SPAWNS = 8;
/** A child's own round cap — smaller than the parent's, because a subtask is smaller. */
export const DEFAULT_CHILD_ROUNDS = 12;

/** The recursion state carried through a turn. Absent ⇒ depth 0, nothing spawned yet. */
export interface SubagentBudget {
  depth: number;
  maxDepth: number;
  spawned: number;
  maxSpawns: number;
}

export function initialBudget(over: Partial<SubagentBudget> = {}): SubagentBudget {
  return {
    depth: 0,
    maxDepth: DEFAULT_MAX_DEPTH,
    spawned: 0,
    maxSpawns: DEFAULT_MAX_SPAWNS,
    ...over,
  };
}

/** Why a spawn was refused — the text the model reads and must be able to act on. */
export type SpawnRefusal = { allowed: false; reason: string };
export type SpawnDecision = { allowed: true } | SpawnRefusal;

/**
 * May this turn spawn a child?
 *
 * Pure and separately testable because it is the safety property: every reason a spawn is
 * refused is a reason a runaway does not happen.
 */
export function canSpawn(budget: SubagentBudget): SpawnDecision {
  if (budget.depth >= budget.maxDepth) {
    return {
      allowed: false,
      reason: `a sub-agent cannot spawn another (depth ${budget.depth} of ${budget.maxDepth}) — do this part of the work yourself`,
    };
  }
  if (budget.spawned >= budget.maxSpawns) {
    return {
      allowed: false,
      reason: `this turn has already spawned ${budget.spawned} sub-agents (limit ${budget.maxSpawns}) — finish with the results you have`,
    };
  }
  return { allowed: true };
}

/** The named roles a spawn may request. Read-only roles are the safe, useful default. */
export const SUBAGENT_ROLES = Object.freeze({
  explore: {
    system:
      "You are an Explore sub-agent. Search and read broadly, then return a findings report " +
      "with file:line anchors. You cannot write files or run commands. Be concise: your " +
      "answer is read by another agent, not by a human.",
    readOnly: true,
  },
  scout: {
    system:
      "You are a Scout sub-agent. Locate specific symbols or usages and return file:line " +
      "results. Read-only. Answer in as few words as carry the facts.",
    readOnly: true,
  },
  /**
   * `plan` — read-only like explore/scout, but its product is a PLAN rather than findings.
   *
   * It is a distinct role and not a prompt flavour of `explore` because the two answer
   * different questions: explore returns "here is what is there", plan returns "here is what
   * to change and in what order". The parent delegating a design question wants the second,
   * and getting the first back costs a whole extra round to convert.
   *
   * Its read-only stance is enforced twice over, by `childTuning`: the deny list strips every
   * non-`readOnlyHint` tool, AND `permissionMode: "plan"` makes the loop itself refuse a
   * mutation. Belt and braces because the deny list is computed from the parent's EXPOSED
   * set — a tool the parent never had is not in it, so a tool reaching the child by some
   * other route would otherwise be ungoverned.
   */
  plan: {
    system:
      "You are a Plan sub-agent. Read whatever you need, then return a concrete, ordered plan: " +
      "the steps, the files each touches, and the risks. You are READ-ONLY — you cannot write " +
      "files or run commands, so do not propose to do so yourself; describe what should be done.",
    readOnly: true,
  },
  build: {
    system:
      "You are a Build sub-agent. Complete the delegated task end to end. Every mutating tool " +
      "still crosses the same gate and still asks the human; never pass --force.",
    readOnly: false,
  },
});

export type SubagentRole = keyof typeof SUBAGENT_ROLES;

export function isSubagentRole(x: unknown): x is SubagentRole {
  return typeof x === "string" && x in SUBAGENT_ROLES;
}

/**
 * Build the child's tuning from the parent's.
 *
 * The direction of every rule here is one-way: `gateMode`, `yes` and the deny list come from
 * the PARENT and can only get stricter. A read-only role additionally denies every tool that
 * is not annotated `readOnlyHint`, computed from the parent's own exposed set — so a child
 * cannot reach a tool the parent never had.
 */
export function childTuning(
  parent: AgentTuning,
  role: SubagentRole,
  task: string,
  exposed: readonly ToolDef[],
  maxRounds?: number,
): AgentTuning {
  const spec = SUBAGENT_ROLES[role];
  const deny = new Set(parent.tools.deny);
  // A sub-agent never spawns — enforced by `canSpawn` too, but removing the tool means the
  // model is not tempted to try and does not waste a round being refused.
  deny.add(SPAWN_AGENT_TOOL.name);
  if (spec.readOnly) {
    for (const t of exposed) {
      if (t.annotations.readOnlyHint !== true) deny.add(t.name);
    }
  }
  return {
    ...parent,
    systemPrompt: `${spec.system}\n\nYour task: ${task}`,
    tools: { ...parent.tools, deny: [...deny] },
    // Inherited, never widened.
    gateMode: parent.gateMode,
    yes: spec.readOnly ? parent.yes : false,
    permissionMode: childPermissionMode(parent.permissionMode, spec.readOnly),
    maxRounds: Math.max(1, Math.min(maxRounds ?? DEFAULT_CHILD_ROUNDS, DEFAULT_CHILD_ROUNDS)),
  };
}

/**
 * The child's permission mode — the one-way rule applied to the posture as well as to tools.
 *
 * A read-only role is pinned to `plan` (the only mode whose matrix DENIES mutations), so the
 * loop refuses a write even if the deny list somehow did not cover the tool. A writable role
 * INHERITS the parent's mode untouched, which is what stops delegation from laundering it: a
 * parent in plan mode spawning a `build` child must not thereby obtain a writable agent.
 *
 * Deliberately not "the stricter of the two": the modes are not a total order (`acceptEdits`
 * and `plan` are different axes), and the only strictness that matters here is deny, which
 * `plan` is. Read-only ⇒ plan; otherwise ⇒ whatever the parent already was.
 */
export function childPermissionMode(
  parentMode: PermissionModeId | undefined,
  readOnly: boolean,
): PermissionModeId | undefined {
  if (readOnly) return "plan";
  return parentMode;
}

/** What a completed child hands back. */
export interface SubagentOutcome {
  ok: boolean;
  /** the child's final text — the ONLY thing that crosses back into the parent's context. */
  text: string;
  rounds: number;
  toolCalls: number;
}

/** Injected so this module stays pure: the host supplies the real `runAgentTurn`. */
export type RunTurn = (
  thread: Thread,
  tuning: AgentTuning,
  deps: AgentTurnDeps,
) => AsyncIterable<AgentEvent>;

/**
 * Run one child turn to completion and return only its final text.
 *
 * The child's events are consumed here rather than forwarded: the parent's transcript should
 * show "delegated X, got Y", not a second interleaved stream of somebody else's tool calls.
 */
export async function runSubagent(
  runTurn: RunTurn,
  tuning: AgentTuning,
  task: string,
  deps: AgentTurnDeps,
): Promise<SubagentOutcome> {
  const thread: Thread = { messages: [{ role: "user", content: task }] };
  let text = "";
  let rounds = 1;
  let toolCalls = 0;
  for await (const ev of runTurn(thread, tuning, deps)) {
    if (ev.kind === "text") text += ev.text;
    else if (ev.kind === "tool_use") toolCalls += 1;
    else if (ev.kind === "status" && /^continuing — round/.test(ev.text)) rounds += 1;
  }
  const trimmed = text.trim();
  return {
    // A child that produced no text FAILED as far as the parent is concerned: an empty
    // delegation result silently becomes "the subtask found nothing", which is a different
    // and often wrong claim.
    ok: trimmed.length > 0,
    text: trimmed || "(the sub-agent returned no answer)",
    rounds,
    toolCalls,
  };
}

export const SPAWN_AGENT_TOOL: ToolDef = {
  name: "spawn_agent",
  title: "Delegate a subtask to a sub-agent",
  description:
    "Delegate a self-contained subtask to a fresh sub-agent and get back ONLY its final " +
    "answer — its intermediate work never enters your context. Use it for wide searches " +
    "('find every caller of X') and for tasks whose details you do not need to keep. " +
    "Roles: `explore` (broad read-only search), `scout` (narrow read-only lookup), `plan` " +
    "(read-only — returns an ordered plan with files and risks, changes nothing), `build` " +
    "(makes changes, still gated). Give a task that is complete on its own; the sub-agent " +
    "cannot see this conversation.",
  schema: {
    task: {
      type: "string",
      required: true,
      description: "the complete, self-contained instruction for the sub-agent",
    },
    role: {
      type: "enum",
      enum: ["explore", "scout", "plan", "build"],
      description: "which kind of sub-agent (default explore)",
    },
    maxRounds: {
      type: "number",
      description: `its round budget (default ${DEFAULT_CHILD_ROUNDS})`,
    },
  },
  // NOT readOnlyHint: a `build` child can change the machine, and the broker must route this
  // to a human. The child's own calls are gated again individually.
  annotations: {},
  toArgv: () => {
    throw new Error("spawn_agent is served by the host runtime, not by prometheus.py");
  },
};
