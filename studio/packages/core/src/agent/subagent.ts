// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/subagent.ts — delegate a subtask to a scoped worker.
 *
 * Why not reuse what is already here: `agents/orchestrator.ts` was an older ReAct loop whose
 * `ToolCall` was `{ref}` where this one's is `{name}` — not assignable, and it has since been
 * deleted; `orchestration/coordinator.ts` genuinely recurses under a budget, but its own nodes
 * are text-only in-process — a `cli`-backed node instead shells out to a real external agentic
 * CLI with its own native tool access entirely outside this module's gating, which is a
 * DIFFERENT, not-yet-addressed exposure the swarm feature carries on its own, not something
 * `spawn_agent` delegation is a substitute for. The loop that actually runs is `runAgentTurn`,
 * and it is already re-entrant because it holds no module state. So this is a thin, guarded
 * re-entry into THAT, not a fourth stack.
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
 *   - **the report is tagged, not just returned** — the guards above bound what the CHILD can
 *     do; they say nothing about content the child merely READ. If its turn touched a web
 *     page, an MCP call, or a repo file — any of which can carry injected instructions the
 *     child's own prose might now be echoing — its final text is wrapped in the same
 *     untrusted-data frame and pattern-scanned (`injection-scan.ts`) before the PARENT ever
 *     sees it, exactly like an MCP call result is. Otherwise a sub-agent would be a laundering
 *     path for untrusted content too: read something hostile once removed, summarize it in
 *     your own words, and the summary arrives with full first-party trust.
 *
 * PURE: no node, no IO. The runner is injected, so the child's tools go through the SAME
 * broker, gate and confirm as the parent's.
 */

import type { AgentEvent } from "./events.js";
import type { AgentTuning, AgentTurnDeps, Thread } from "./loop.js";
import type { PermissionModeId } from "./permission-modes.js";
import { CORE_TURN_CONTRIBUTORS } from "./protocol/contributors/index.js";
import { defangFrameMarkers, hasFrameMarker } from "./protocol/frame-body.js";
import { scanForInjectionSignals } from "./protocol/injection-scan.js";
import { MCP_TOOL_PREFIX } from "./protocol/mcp-tools.js";
import {
  type PreambleCtx,
  assemblePreamble,
  instructionBudget,
} from "./protocol/preamble-dispatch.js";
import type { ToolDef } from "./tools.js";

/**
 * Tools whose result carries content from OUTSIDE the person you're working with — a fetched
 * page, an MCP server's own text, or repo file content the workspace (not the user) authored
 * (a `git_diff`/`git_show`/`git_log` result is exactly this: an untrusted contributor's commit
 * message or diff, same risk class as `read_file`/`grep`). An MCP call is matched by its `mcp__`
 * namespace prefix rather than listed by name, since new servers are added at runtime. The
 * content check on top of the name list is a second signal for a surface not on it, or added
 * later — anything already carrying one of the other untrusted-data frames (all named
 * `<<untrusted-*-data`, including this module's own, see `wrapUntrustedReport`) counts too, so
 * this does not need updating every time a new wrapper is introduced elsewhere.
 */
const UNTRUSTED_SURFACE_TOOLS = new Set([
  "web_fetch",
  "web_search",
  "read_file",
  "grep",
  "semantic_search",
  "git_diff",
  "git_show",
  "git_log",
]);

/** Whether one tool call's result means the child was exposed to untrusted content. */
function touchedUntrustedSurface(toolName: string, summary: string): boolean {
  if (UNTRUSTED_SURFACE_TOOLS.has(toolName)) return true;
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return true;
  // One matcher, shared with the framers. The inline expression this replaced required
  // whitespace or a quote right after `-data`, so it did NOT match `<<untrusted-subagent-data>>`
  // — the marker written a few lines below, whose own comment claimed it was named `-data`
  // precisely so it would match this check.
  return hasFrameMarker(summary);
}

/**
 * The header/scan/footer any untrusted-data frame in this codebase shares (mirrors `mcpOutcome`).
 * Named `-data`, not `-report`, so it matches its OWN fallback regex above — inert today (a
 * child can never reach `spawn_agent` at all, `childTuning` denies it for every role, so a
 * grandchild's already-wrapped report can't reach here to test this), but a frame that failed to
 * recognize itself would be a silent trap the moment that default ever changed.
 */
function wrapUntrustedReport(text: string): string {
  const scan = scanForInjectionSignals(text);
  const warn = scan.flagged
    ? `\n[warning: possible injected instructions detected — ${scan.signals.join(", ")}]`
    : "";
  return `<<untrusted-subagent-data>>\n${defangFrameMarkers(text)}\n<<end untrusted-subagent-data>>${warn}`;
}

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
/** The parent's endpoint facts `childTuning` cannot derive on its own — threaded through by the
 *  caller (which already resolved them for the PARENT's own turn), so a child's preamble is
 *  assembled against the SAME facts, not a permanently-unknown/no-window placeholder. */
export interface ChildEndpointCtx {
  locality?: "local" | "cloud";
  contextWindow?: number;
  /** the parent endpoint's resolved `EffortMechanism` (`ai/effort/types.ts`) — omitted (not
   *  `"unknown"`) when the caller has none, so `effort-text`'s own "unresolved ⇒ assume the
   *  worst" rule still applies rather than this module inventing a different default. */
  effortMechanism?: string;
}

export function childTuning(
  parent: AgentTuning,
  role: SubagentRole,
  task: string,
  exposed: readonly ToolDef[],
  maxRounds?: number,
  endpointCtx?: ChildEndpointCtx,
): AgentTuning {
  const spec = SUBAGENT_ROLES[role];
  const deny = new Set(parent.tools.deny);
  // A sub-agent never spawns — enforced by `canSpawn` too, but removing the tool means the
  // model is not tempted to try and does not waste a round being refused.
  deny.add(SPAWN_AGENT_TOOL.name);
  if (spec.readOnly) {
    for (const t of exposed) {
      // A read-only child may not reach the network either: `openWorldHint` tools are denied
      // even when they also carry `readOnlyHint`. web_search carries BOTH — it mutates nothing
      // yet sends the query off the machine — so a readOnly-hint-only filter handed a Plan
      // sub-agent live egress, while the `permissionMode: "plan"` half of the same "belt and
      // braces" already refused it. The two halves now agree.
      if (t.annotations.readOnlyHint !== true || t.annotations.openWorldHint === true) {
        deny.add(t.name);
      }
    }
  }
  /**
   * The SAME preamble dispatch pipeline every top-level turn uses
   * (`apps/cli/src/session/agent-runtime.ts`'s `runMessageTurn`) — a `spawn_agent` child was
   * previously handed ONLY `spec.system`, so a `build` child (the one role that CAN write
   * files) got no `AGENT_TOOL_DISCIPLINE`, no pre-write-recheck, and no effort-as-text at all.
   * `readOnly: spec.readOnly` is what makes `tool-discipline`/`pre-write-recheck` render their
   * read-only-safe variants (or nothing, for pre-write-recheck) for explore/scout/plan.
   *
   * `locality`/`contextWindow`/`effortMechanism` come from the PARENT's own already-resolved
   * endpoint facts (via `endpointCtx`) rather than a permanent "unknown"/no-window placeholder —
   * without `effortMechanism` specifically, `effort-text`'s "unresolved ⇒ offer the nudge
   * anyway" rule always fired for a child, even on a model whose mechanism ALREADY carries the
   * tier some other way, double-injecting the effort instruction in two registers at once.
   */
  const preambleCtx: PreambleCtx = {
    surface: "subagent",
    isSubAgent: true,
    subagentRole: role,
    readOnly: spec.readOnly,
    modelId: parent.model.modelId,
    locality: endpointCtx?.locality ?? "unknown",
    ...(endpointCtx?.contextWindow ? { contextWindow: endpointCtx.contextWindow } : {}),
    effortTier: parent.effort,
    ...(endpointCtx?.effortMechanism ? { effortMechanism: endpointCtx.effortMechanism } : {}),
    tools: exposed,
  };
  const assembled = assemblePreamble(
    CORE_TURN_CONTRIBUTORS,
    preambleCtx,
    instructionBudget(endpointCtx?.contextWindow),
  );
  const persona = `${spec.system}\n\nYour task: ${task}`;
  return {
    ...parent,
    systemPrompt: assembled.personaAppend ? `${persona}\n\n${assembled.personaAppend}` : persona,
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
 * show "delegated X, got Y", not a second interleaved stream of somebody else's tool calls. The
 * SAME consumption loop is what lets this track whether the child touched untrusted content —
 * every `tool_result` it will ever see already flows past here, so no new instrumentation is
 * needed in the turn loop itself, only a check on what was already there.
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
  let touchedUntrusted = false;
  for await (const ev of runTurn(thread, tuning, deps)) {
    if (ev.kind === "text") text += ev.text;
    else if (ev.kind === "tool_use") toolCalls += 1;
    else if (ev.kind === "tool_result") {
      if (touchedUntrustedSurface(ev.call.name, ev.summary)) touchedUntrusted = true;
    } else if (ev.kind === "status" && /^continuing — round/.test(ev.text)) rounds += 1;
  }
  const trimmed = text.trim();
  // A child that produced no text FAILED as far as the parent is concerned: an empty
  // delegation result silently becomes "the subtask found nothing", which is a different
  // and often wrong claim. Nothing to frame in the placeholder case — there is no content.
  const ok = trimmed.length > 0;
  const finalText =
    ok && touchedUntrusted
      ? wrapUntrustedReport(trimmed)
      : trimmed || "(the sub-agent returned no answer)";
  return { ok, text: finalText, rounds, toolCalls };
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
