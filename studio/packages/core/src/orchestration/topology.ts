// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/topology.ts — the `/demos` agent topology (the multi-CLI swarm config).
 *
 * A topology is a TREE of agents. The ROOT is the orchestrator; every other node is a
 * subagent bound to exactly ONE backend (a vendor CLI like claude/codex/gemini, a local
 * model, the in-process agent, or a fake for tests) and given a role/specialty. A
 * subagent may itself parent child-subagents, so the whole thing is a hierarchy the
 * coordinator walks. PURE: types + validation + tree queries; no IO, no spawning.
 */

/**
 * Which kind of backend powers an agent.
 *   cli         — a vendor agentic CLI (claude/codex/gemini/cursor), spawned headless.
 *   local       — a local OpenAI-compatible model (Ollama/LM Studio) — free, private.
 *   engine-chat — the python engine's local chat path.
 *   in-process  — the engine's in-process agent.
 *   api         — a paid OpenAI-compatible API provider reached over HTTP with the user's
 *                 OWN api key (Together/Fireworks/Groq/OpenRouter/nexos/abacus/…). The
 *                 ToS-clean automation lane: own-key commercial API, no CLI-driving.
 *   fake        — a canned reply (tests / dry-run).
 */
export type BackendKind = "cli" | "local" | "engine-chat" | "in-process" | "api" | "fake";

/** A binding to ONE backend. `service` is a vendor id (claude/codex/…) for `cli`; `model` the model id. */
export interface BackendRef {
  kind: BackendKind;
  /** vendor/service id for kind:"cli" or the provider id for kind:"api" (e.g. "claude", "together"). */
  service?: string;
  /** model id for local / engine-chat / in-process / api (e.g. "qwen2.5-coder", "deepseek-chat"). */
  model?: string;
  /** an OpenAI-compatible base URL for kind:"local" (else the detected default) or kind:"api". */
  baseUrl?: string;
  /** the env var holding the API key for kind:"api" (e.g. "TOGETHER_API_KEY"). */
  apiKeyEnv?: string;
  /**
   * extra env for THIS agent's process (kind:"cli") — e.g. a dedicated API key so each
   * subagent uses its own account. It is ADDED to the child env; it never patches the
   * vendor CLI's install/config — the CLI still runs exactly as it would standalone. For
   * kind:"api" it may carry the API key value (read by the HTTP invoker, never spawned).
   */
  env?: Record<string, string>;
}

/** What an agent is allowed to do (least-privilege; anti prompt-injection). */
export type AgentOp = "delegate" | "spawn" | "report" | "broadcast";

/** Every op (the default when an agent declares no restriction). */
export const ALL_OPS: readonly AgentOp[] = Object.freeze([
  "delegate",
  "spawn",
  "report",
  "broadcast",
]);

/** One agent in the topology. `name` is its unique address segment. */
export interface AgentSpec {
  /** unique, address-safe id (no "/" or whitespace) — the orchestrator's name too. */
  name: string;
  /** the backend that runs this agent. */
  backend: BackendRef;
  /** the agent's specialty / system role (e.g. "backend code", "tests", "review"). */
  role: string;
  /** an optional longer description fed into the agent's system prompt. */
  description?: string;
  /** names of agents that are DIRECT children (subagents) of this one. */
  children?: string[];
  /**
   * CAPABILITY scope — the ops this agent may perform (least privilege). A read-only
   * "scout"/"review" agent gets ["report"] so a prompt-injected `@spawn` it emits is
   * dropped regardless of its output. undefined ⇒ all ops (the orchestrator default).
   */
  allowedOps?: AgentOp[];
}

/** Per-run safety + resource limits. */
export interface RunLimits {
  /** max tree depth from the orchestrator (root depth 0). */
  maxDepth: number;
  /** max children one agent may dispatch/spawn in a single turn. */
  maxFanout: number;
  /** max total agent invocations in a run (runaway guard). */
  maxAgents: number;
  /** wall-clock budget for the whole run. */
  timeoutMs: number;
  /** optional metered-spend ceiling (USD) across the run; undefined = no ceiling. */
  maxCostUsd?: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxDepth: 3,
  maxFanout: 6,
  maxAgents: 24,
  timeoutMs: 30 * 60 * 1000,
};

/** The persisted `/demos` topology (saved under ~/.prometheus/orchestration/topology.json). */
export interface OrchestrationTopology {
  version: 1;
  /** the name of the root agent (must be present in `agents`). */
  orchestrator: string;
  agents: AgentSpec[];
  limits: RunLimits;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Look up an agent by name. */
export function getAgent(t: OrchestrationTopology, name: string): AgentSpec | undefined {
  return t.agents.find((a) => a.name === name);
}

/** The direct children (subagent specs) declared under `name`. */
export function childrenOf(t: OrchestrationTopology, name: string): AgentSpec[] {
  const spec = getAgent(t, name);
  if (!spec?.children) return [];
  return spec.children.map((c) => getAgent(t, c)).filter((a): a is AgentSpec => a !== undefined);
}

/** The peers an agent may address directly (its siblings + its parent + its own children). */
export function peersOf(t: OrchestrationTopology, name: string): string[] {
  const parent = parentOf(t, name);
  const siblings = parent ? (getAgent(t, parent)?.children ?? []) : [t.orchestrator];
  const kids = getAgent(t, name)?.children ?? [];
  const set = new Set<string>([...siblings, ...kids]);
  if (parent) set.add(parent);
  set.delete(name);
  return [...set];
}

/** The parent of an agent (the agent that lists it in `children`), or undefined for the root. */
export function parentOf(t: OrchestrationTopology, name: string): string | undefined {
  return t.agents.find((a) => a.children?.includes(name))?.name;
}

/** The ancestry chain from an agent up to (and including) the root. */
export function ancestryOf(t: OrchestrationTopology, name: string): string[] {
  const chain: string[] = [];
  let cur: string | undefined = name;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = parentOf(t, cur);
  }
  return chain;
}

/** The depth of an agent (root = 0). */
export function depthOf(t: OrchestrationTopology, name: string): number {
  return Math.max(0, ancestryOf(t, name).length - 1);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a topology: version, non-empty agents, a present orchestrator, unique +
 * address-safe names, child references that resolve, no node with two parents, and a
 * TREE rooted at the orchestrator (acyclic, every agent reachable from the root).
 */
export function validateTopology(t: OrchestrationTopology): ValidationResult {
  const errors: string[] = [];
  if (t.version !== 1) errors.push(`unsupported topology version ${t.version}`);
  if (!t.agents || t.agents.length === 0) errors.push("topology has no agents");

  const names = new Set<string>();
  for (const a of t.agents ?? []) {
    if (!NAME_RE.test(a.name))
      errors.push(`invalid agent name "${a.name}" (use [A-Za-z][A-Za-z0-9_-]*)`);
    if (names.has(a.name)) errors.push(`duplicate agent name "${a.name}"`);
    names.add(a.name);
    if (!a.backend?.kind) errors.push(`agent "${a.name}" has no backend.kind`);
    if (a.backend?.kind === "cli" && !a.backend.service)
      errors.push(`agent "${a.name}" is a cli backend but names no service`);
    if (a.backend?.kind === "api" && !a.backend.baseUrl)
      errors.push(`agent "${a.name}" is an api backend but has no baseUrl`);
  }

  if (!names.has(t.orchestrator)) errors.push(`orchestrator "${t.orchestrator}" is not in agents`);

  // child references resolve + no node has two parents
  const parentOfChild = new Map<string, string>();
  for (const a of t.agents ?? []) {
    for (const c of a.children ?? []) {
      if (!names.has(c)) errors.push(`agent "${a.name}" lists unknown child "${c}"`);
      if (c === a.name) errors.push(`agent "${a.name}" lists itself as a child`);
      const prev = parentOfChild.get(c);
      if (prev) errors.push(`agent "${c}" has two parents ("${prev}" and "${a.name}")`);
      else parentOfChild.set(c, a.name);
    }
  }
  if (t.orchestrator && parentOfChild.has(t.orchestrator))
    errors.push(`orchestrator "${t.orchestrator}" cannot be a child of another agent`);

  // reachability + acyclicity: a BFS from the root must visit every agent exactly once.
  // (Safe even with malformed child refs — unknown names resolve to no children; the
  // `seen` guard breaks any cycle — so we run it regardless of the errors above.)
  if (names.has(t.orchestrator)) {
    const seen = new Set<string>();
    const queue = [t.orchestrator];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (seen.has(cur)) {
        errors.push(`cycle detected at "${cur}"`);
        break;
      }
      seen.add(cur);
      for (const c of getAgent(t, cur)?.children ?? []) queue.push(c);
    }
    for (const a of t.agents) {
      if (!seen.has(a.name)) errors.push(`agent "${a.name}" is unreachable from the orchestrator`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Apply defaults + light coercion to a parsed topology (limits, version). */
export function normalizeTopology(raw: Partial<OrchestrationTopology>): OrchestrationTopology {
  return {
    version: 1,
    orchestrator: raw.orchestrator ?? "orchestrator",
    agents: raw.agents ?? [],
    limits: { ...DEFAULT_LIMITS, ...(raw.limits ?? {}) },
  };
}
