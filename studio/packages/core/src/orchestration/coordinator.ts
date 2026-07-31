/**
 * orchestration/coordinator.ts — the `/demos` orchestration engine.
 *
 * Drives a hierarchy of heterogeneous agents to develop code together. Each node runs a
 * BOUNDED agentic loop: gather its inbox (peer messages + prior child results) + its
 * task → invoke its backend → parse directives → fan out delegations/spawns to peers +
 * children IN PARALLEL (depth/fan-out/cost/cycle guarded) → synthesize. Results flow back
 * up the call tree; EVERY message is on the shared MessageBus, so the orchestrator,
 * subagents, and child-subagents all communicate + the whole run is transparent + replayable.
 *
 * PURE given the injected `BackendInvoker` (the only thing that touches a real CLI/model/
 * network), `clock`, and `genId`. The invoker resolves a backend kind → text; the
 * coordinator owns the protocol, the routing, and the safety budget.
 */
import { MessageBus } from "./bus.js";
import { RunBudget } from "./guards.js";
import { parseBackendRef, parseDirectives } from "./protocol.js";
import {
  type AgentSpec,
  type OrchestrationTopology,
  getAgent,
  parentOf,
  peersOf,
} from "./topology.js";

/** The single seam that runs an agent's prompt on its bound backend → text (+ cost). */
export interface InvokeRequest {
  agent: AgentSpec;
  /** the fully-built prompt (role + task + inbox context + directive help). */
  prompt: string;
  taskId: string;
  turn: number;
  signal?: AbortSignal;
}
export interface InvokeResult {
  text: string;
  /** metered spend for this call (USD), if the backend reports it. */
  costUsd?: number;
}
export type BackendInvoker = (req: InvokeRequest) => Promise<InvokeResult>;

/** A high-level run event (the TUI live view subscribes to these + the bus). */
export type RunEvent =
  | { type: "agent-start"; agent: string; depth: number; task: string }
  | { type: "agent-end"; agent: string; depth: number; result: string }
  | { type: "dispatch"; from: string; to: string; task: string }
  | { type: "spawn"; parent: string; child: string; backend: string }
  | { type: "blocked"; agent: string; reason: string };

export interface CoordinatorDeps {
  topology: OrchestrationTopology;
  invoke: BackendInvoker;
  bus?: MessageBus;
  now?: () => number;
  genId?: () => string;
  onEvent?: (e: RunEvent) => void;
  /** bounded agentic turns per node (fan-out → synthesize). Default 3. */
  maxTurnsPerAgent?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  answer: string;
  bus: MessageBus;
  invocations: number;
  spentUsd: number;
  /** every agent that existed in the run (topology + dynamically spawned). */
  agents: AgentSpec[];
}

const USER = "user";

/** Headless "respawn" cap (CLI-075): a transient backend failure is re-issued at most this many
 *  times (no process to restart — a fresh call, not a resumed stream). */
const HEADLESS_RESPAWN_CAP = 1;

/**
 * Is a backend error TRANSIENT (worth a re-issue) vs PERMANENT (CLI-075)? Rate-limits, 5xx, and
 * timeouts are transient; auth/bad-request (400/401/403/404) are permanent — retrying them only
 * burns quota. Classified from the error text (the invoker surfaces status/code in the message).
 */
export function isTransientBackendError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b(4(?:00|01|03|04))\b/.test(msg)) return false; // permanent — never retry
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  return /rate.?limit|timeout|timed out|etimedout|econnreset|eai_again|temporarily|unavailable|overloaded/.test(
    msg,
  );
}

/** Build the prompt for one agent turn: role + task + inbox + the roster + directive help. */
export function buildPrompt(
  agent: AgentSpec,
  task: string,
  inbox: { from: string; content: string }[],
  roster: string[],
): string {
  const parts: string[] = [
    `You are "${agent.name}", a ${agent.role} agent in a Prometheus multi-agent swarm.`,
  ];
  if (agent.description) parts.push(agent.description);
  if (roster.length > 0) {
    parts.push(
      [
        `Agents you can talk to: ${roster.join(", ")}.`,
        "To delegate a subtask:  @<name>: <task>",
        "To report up to whoever asked you:  @parent: <text>   (or  >> <text>)",
        "To message everyone:  @all: <text>",
        "To create a helper bound to a backend:  @spawn <name>=<backend>: <task>",
        "Put each directive on its OWN line. Otherwise just write your answer.",
      ].join("\n"),
    );
  }
  parts.push(`TASK:\n${task}`);
  if (inbox.length > 0) {
    parts.push(`Messages for you:\n${inbox.map((m) => `- ${m.from}: ${m.content}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Run a `/demos` orchestration. `run(goal)` seeds the orchestrator with the goal and
 * returns its synthesized answer plus the full bus + run stats.
 */
export class Coordinator {
  private readonly deps: CoordinatorDeps;
  private readonly bus: MessageBus;
  private readonly budget: RunBudget;
  private readonly genId: () => string;
  private readonly onEvent: (e: RunEvent) => void;
  private readonly maxTurns: number;
  private readonly agents = new Map<string, AgentSpec>();
  /** dynamic parent links for spawned agents (augments the static topology). */
  private readonly dynParent = new Map<string, string>();
  private idSeq = 0;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    const now = deps.now ?? (() => Date.now());
    this.bus = deps.bus ?? new MessageBus({ now, genId: deps.genId });
    this.budget = new RunBudget(deps.topology.limits, now);
    this.genId = deps.genId ?? (() => `t${(this.idSeq++).toString(36)}`);
    this.onEvent = deps.onEvent ?? (() => {});
    this.maxTurns = Math.max(1, deps.maxTurnsPerAgent ?? 3);
    for (const a of deps.topology.agents) this.agents.set(a.name, a);
  }

  /** Drive the whole run from the user's goal. */
  async run(goal: string): Promise<RunResult> {
    const orch = this.deps.topology.orchestrator;
    const answer = await this.runAgent(orch, goal, 0, [], USER, this.genId());
    return {
      answer,
      bus: this.bus,
      invocations: this.budget.invocations,
      spentUsd: this.budget.spentUsd,
      agents: [...this.agents.values()],
    };
  }

  /** The static-or-dynamic parent of an agent (for posting results upward). */
  private parentOfAgent(name: string): string | undefined {
    return parentOf(this.deps.topology, name) ?? this.dynParent.get(name);
  }

  /** The call-genealogy of an agent (static ancestry merged with the live call stack). */
  private peersFor(name: string): string[] {
    const staticPeers = getAgent(this.deps.topology, name) ? peersOf(this.deps.topology, name) : [];
    // a spawned agent can talk to its dynamic parent + the orchestrator.
    const dyn = this.dynParent.get(name);
    const set = new Set([...staticPeers, ...(dyn ? [dyn] : [])]);
    set.delete(name);
    return [...set];
  }

  /** Resolve (or create) the target of a spawn directive; returns its spec or null. */
  private resolveSpawn(parentName: string, name: string, backendToken: string): AgentSpec | null {
    const existing = this.agents.get(name);
    if (existing) return existing; // address an already-spawned agent by name
    const spec: AgentSpec = {
      name,
      backend: parseBackendRef(backendToken),
      role: `helper spawned by ${parentName}`,
    };
    this.agents.set(name, spec);
    this.dynParent.set(name, parentName);
    return spec;
  }

  /**
   * Run one agent: a bounded loop of (invoke → parse → fan out children → synthesize).
   * Returns the agent's final result text; posts it to `replyTo` on the bus.
   */
  /**
   * Invoke the backend, re-issuing a TRANSIENT failure up to HEADLESS_RESPAWN_CAP times (CLI-075).
   * Each attempt charges the budget (a real call). A PERMANENT error (auth/bad-request) or an abort
   * throws immediately — no wasted quota. Immediate re-issue (no backoff) so a retry can't stall the
   * relay's per-tick accounting.
   */
  private async invokeWithRetry(req: InvokeRequest): Promise<InvokeResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.budget.charge();
        return await this.deps.invoke(req);
      } catch (err) {
        if (
          attempt >= HEADLESS_RESPAWN_CAP ||
          this.deps.signal?.aborted ||
          !isTransientBackendError(err)
        ) {
          throw err;
        }
      }
    }
  }

  private async runAgent(
    name: string,
    task: string,
    depth: number,
    ancestry: string[],
    replyTo: string,
    taskId: string,
  ): Promise<string> {
    const spec = this.agents.get(name);
    if (!spec) {
      const reason = `unknown agent "${name}"`;
      this.onEvent({ type: "blocked", agent: name, reason });
      this.bus.post({ from: name, to: replyTo, kind: "error", content: reason, taskId });
      return `[error] ${reason}`;
    }

    const gate = this.budget.canProceed(depth, ancestry, name);
    if (!gate.ok) {
      const reason = gate.reason ?? "blocked";
      this.onEvent({ type: "blocked", agent: name, reason });
      this.bus.post({ from: name, to: replyTo, kind: "error", content: reason, taskId });
      return `[blocked] ${reason}`;
    }

    this.onEvent({ type: "agent-start", agent: name, depth, task });
    this.bus.post({ from: replyTo, to: name, kind: "task", content: task, taskId });
    const nextAncestry = [...ancestry, name];
    let finalResult = "";

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      if (this.deps.signal?.aborted) {
        finalResult = "[aborted]";
        break;
      }
      // gate EVERY invocation (not just runAgent entry) so multi-turn synthesis + parallel
      // sibling turns can't push past the agents/timeout/cost ceilings.
      const turnGate = this.budget.canProceed(depth, ancestry);
      if (!turnGate.ok) {
        const reason = turnGate.reason ?? "budget exhausted";
        this.onEvent({ type: "blocked", agent: name, reason });
        this.bus.post({ from: name, to: replyTo, kind: "error", content: reason, taskId });
        finalResult = finalResult || `[blocked] ${reason}`;
        break;
      }
      // the inbox carries PEER messages + child RESULTS — NOT this agent's own task
      // assignment (which is already the TASK section); draining still advances the cursor.
      const inbox = this.bus
        .drainFor(name)
        .filter((m) => m.kind !== "task")
        .map((m) => ({ from: m.from, content: m.content }));
      const prompt = buildPrompt(spec, task, inbox, this.peersFor(name));

      let out: InvokeResult;
      try {
        out = await this.invokeWithRetry({
          agent: spec,
          prompt,
          taskId,
          turn,
          ...(this.deps.signal ? { signal: this.deps.signal } : {}),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.bus.post({ from: name, to: replyTo, kind: "error", content: reason, taskId });
        finalResult = `[backend error] ${reason}`;
        break;
      }
      // add metered cost WITHOUT counting another invocation (charge() already counted it).
      if (typeof out.costUsd === "number") this.budget.addCost(out.costUsd);

      const parsed = parseDirectives(out.text);
      finalResult = parsed.result || finalResult;

      // CAPABILITY scope: drop any directive this agent isn't allowed to emit (least
      // privilege — a prompt-injected `@spawn` from a report-only scout is refused here,
      // not at the backend). undefined allowedOps ⇒ all ops permitted.
      const allowed = spec.allowedOps;
      const directives = allowed
        ? parsed.directives.filter((d) => {
            const op = d.kind === "delegate" ? "delegate" : d.kind;
            if (allowed.includes(op as (typeof allowed)[number])) return true;
            this.bus.post({
              from: name,
              to: name,
              kind: "error",
              content: `dropped ${op} directive: "${name}" is not permitted to ${op}`,
              taskId,
            });
            return false;
          })
        : parsed.directives;

      // route the non-task directives (report up / broadcast) onto the bus.
      for (const d of directives) {
        if (d.kind === "report") {
          this.bus.post({
            from: name,
            to: this.parentOfAgent(name) ?? replyTo,
            kind: "msg",
            content: d.content,
            taskId,
          });
        } else if (d.kind === "broadcast") {
          this.bus.post({ from: name, to: "broadcast", kind: "msg", content: d.content, taskId });
        }
      }

      // the task-producing directives (delegate / spawn) — capped to maxFanout.
      const dispatches = directives
        .filter(
          (d): d is Extract<typeof d, { kind: "delegate" | "spawn" }> =>
            d.kind === "delegate" || d.kind === "spawn",
        )
        .slice(0, this.deps.topology.limits.maxFanout);

      if (dispatches.length === 0) break; // no fan-out → this turn's result is final

      // run all children IN PARALLEL; their results land in this agent's inbox for the
      // NEXT turn (where it synthesizes). Each child is wrapped so an UNEXPECTED throw in
      // one (resolveSpawn / a subscriber) can never abort its siblings or the parent.
      await Promise.all(
        dispatches.map(async (d) => {
          try {
            let target: string;
            if (d.kind === "spawn") {
              const created = this.resolveSpawn(name, d.name, d.backend);
              if (!created) return;
              this.onEvent({ type: "spawn", parent: name, child: d.name, backend: d.backend });
              target = d.name;
            } else {
              target = d.to;
              if (!this.agents.has(target)) {
                this.bus.post({
                  from: name,
                  to: name,
                  kind: "error",
                  content: `cannot delegate to unknown agent "${target}"`,
                  taskId,
                });
                return;
              }
            }
            this.onEvent({ type: "dispatch", from: name, to: target, task: d.task });
            // runAgent posts the child's result to `name` (its replyTo) on completion, so it
            // lands in THIS agent's inbox for the next-turn synthesis — no duplicate post here.
            await this.runAgent(target, d.task, depth + 1, nextAncestry, name, this.genId());
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.bus.post({
              from: name,
              to: name,
              kind: "error",
              content: `child dispatch failed: ${reason}`,
              taskId,
            });
          }
        }),
      );
      // loop: next turn drains the child results + synthesizes.
    }

    this.onEvent({ type: "agent-end", agent: name, depth, result: finalResult });
    this.bus.post({ from: name, to: replyTo, kind: "result", content: finalResult, taskId });
    return finalResult;
  }
}

/** Convenience: run a topology against a goal with an injected invoker. */
export async function runOrchestration(goal: string, deps: CoordinatorDeps): Promise<RunResult> {
  return new Coordinator(deps).run(goal);
}
