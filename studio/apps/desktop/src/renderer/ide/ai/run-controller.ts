// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/run-controller.ts — the MODULE-LEVEL agent run controller (APP-056).
 *
 * In-flight agent runs used to live on the AgentPane component (an abort map + the loop
 * invocation), so leaving the AI pane ABORTED every run. This singleton owns that state
 * OUTSIDE React — the abort controllers, the agent-loop invocation, the awaiting-approval
 * state, the per-session token usage, and the run-status
 * subscribers. All transcript/stream mutations still flow through `useAiSessionStore`
 * actions (already lifecycle-free), so a run keeps progressing to completion with ZERO
 * components mounted, and a returning pane reattaches to the live store state automatically.
 *
 * Abort is now ONLY ever user-initiated (`cancel`) or a supersede-restart (`start` cancels
 * the prior run for the same session). No unmount/cleanup path calls `.abort()`.
 *
 * §9c: the loop it drives is CORE's `runAgentTurn` (via ai/core-agent.ts), not the pane's
 * old fork — so the GUI now gets the --force ban, the §4.3 broker, the nemesis BLOCK abort
 * and byte-accurate output capping that the fork never had. The fork's explicit
 * pause/resume state machine is gone with it: core's `confirm` hook is an ordinary await
 * inside the generator, so a run waiting on a task card is simply a suspended turn rather
 * than a serialized `{status:"paused", convo, itersUsed}` snapshot that had to be threaded
 * back in exactly right.
 *
 * C5: imports ONLY PURE renderer modules + core's node-free agent subpaths + the zustand
 * store (lifecycle-free via `getState()`) — never the `@prometheus/core` barrel.
 */
import type { LoadedAgent } from "@prometheus/core/agent-files";
import { personaDeny, personaSystemPrompt } from "@prometheus/core/agent-files";
import type { ConfirmResult, Thread, ToolCall, ToolOutcome } from "@prometheus/core/agent-loop";
import { runAgentTurn } from "@prometheus/core/agent-loop";
import { ScopedPermissionStore, withRememberedGrants } from "@prometheus/core/agent-permissions";
import { allMcpToolDefs, isMcpToolName } from "@prometheus/core/agent-protocol";
import {
  canAsk,
  initialQuestionBudget,
  renderAnswer,
  renderQuestion,
} from "@prometheus/core/agent-question";
import {
  canSpawn,
  childTuning,
  initialBudget,
  isSubagentRole,
  runSubagent,
} from "@prometheus/core/agent-subagent";
import { TodoStore, runTodoTool, todoSummary } from "@prometheus/core/agent-todo";
import type { ToolDef } from "@prometheus/core/agent-tools";
import { exposedTools } from "@prometheus/core/agent-tools";

import type { LatencyPhases } from "@prometheus/ui";

import type { AgentSystemToolResult, McpAgentServer } from "../../../shared/ipc-contract.js";
import { useAuthorisationStore } from "../../stores/authorisation.js";
import { runNotebookTool } from "../notebook/notebook-tool.js";
import { useAiSessionStore } from "../state/stores.js";
import type { AgentLoopDeps, AiMsg, CommandResult } from "./agent-loop.js";
import {
  AGENT_PANE_ALLOW,
  agentPaneTuning,
  createRendererLlmClient,
  createRendererToolRunner,
  listPaneHooks,
  makeIdeHookRunner,
  runCoreAgentTurn,
} from "./core-agent.js";
// The autonomy ladder lives in permission-gate.ts beside `needsPermission`, so there is ONE
// module in the renderer that answers "must a human be asked" — and it answers with core's
// functions rather than a renderer copy of them.
import { autoApprovesToolCall } from "./permission-gate.js";

import { type UsageTotals, accumulateUsage, emptyTotals } from "./usage-cost.js";

/** The message list a run starts from (system + prior turns + new user turn). */
type LoopMessages = AiMsg[];
/** Injectable loop runner — lets a test script a turn without a model. */
type LoopRunner = (messages: LoopMessages, deps: AgentLoopDeps) => Promise<void>;

/** A result a task card already produced, tagged with the tool it came from. */
export interface CardResultStash {
  tool: string;
  result: CommandResult;
}

/**
 * Decide whether a system-tool dispatch should REPLAY a task card's result or actually run.
 *
 * Pure, and named, because the rule is the fix for a real defect. When the broker routes a call
 * to a human, the task card runs the tool while the turn is suspended in `confirm` — so
 * dispatching again afterwards executes it TWICE. That was masked while `run_command` was the
 * only tool a human could be asked about; once the card began presenting every such tool it
 * became a live bug for `propose_elevated` and `job_kill` (no annotations ⇒ no level
 * auto-approves them) and, at authorisation level 0, for every read.
 *
 * Two rules, both load-bearing:
 *  - Replay ONLY when the stashed result came from the same tool. A card approved for a call
 *    the loop then abandoned must not have its output handed to the next tool as if it were
 *    that tool's — that is a fabricated result, and the model would build on it.
 *  - Prefer the UNFLATTENED result. Reconstructing from stdout/stderr/exit loses the gate
 *    `verdict`, and core's loop aborts the turn on a `block`; without it a blocked command
 *    reads as an ordinary failure and the turn carries on.
 *
 * Returns the outcome to replay, or null meaning "dispatch it for real".
 */
export function claimCardResult(
  stash: CardResultStash | undefined,
  name: string,
): AgentSystemToolResult | null {
  if (!stash || stash.tool !== name) return null;
  const r = stash.result;
  if (r.raw) return r.raw;
  const body = [r.stdout, r.stderr].filter(Boolean).join("\n");
  return { ok: (r.exit ?? 0) === 0, summary: body, data: { exitCode: r.exit ?? 0 } };
}

/** What the component hands `start`: the messages + the deps MINUS the signal (we mint it). */
export interface StartParams {
  messages: LoopMessages;
  deps: Omit<AgentLoopDeps, "signal">;
  /** test seam: override the loop runner (defaults to the real core loop). */
  run?: LoopRunner;
}

/**
 * A run SUSPENDED inside core's `confirm`, waiting for the human to answer a task card.
 *
 * This replaces the fork's `PausedEntry`. The difference is not cosmetic: the fork returned
 * from the loop, stashed `{convo, pending, itersUsed}`, and re-entered a fresh loop with
 * that snapshot — so the resume had to reconstruct budget and message order by hand. Here
 * the generator never returned; `resolve` simply answers the await it is sitting on, and
 * the loop continues with its own state intact.
 */
interface AwaitingEntry {
  ac: AbortController;
  cards: { id: string; command: string }[];
  /** cardId → the deferred that core's `confirm` (and the tool runner) are awaiting. */
  pending: Map<string, (r: CommandResult) => void>;
}

class AgentRunController {
  private readonly abort = new Map<string, AbortController>();
  private readonly awaiting = new Map<string, AwaitingEntry>();
  /**
   * sid → the result a task card already produced, waiting for the tool runner to claim it.
   *
   * One slot, not a map keyed by command text: core calls `confirm` and then `runTool` for the
   * SAME call, back to back, so there is only ever one approved-but-unread result per session.
   * Keying by the command string would collide the moment a model proposed the same command
   * twice in one turn and hand the second call the first one's exit code.
   *
   * Tagged with the TOOL it came from, so the runner can never hand one tool's output back as
   * another tool's result — see `claimCardResult`.
   */
  private readonly approvedCommand = new Map<string, CardResultStash>();
  private readonly proposed = new Map<string, { id: string; command: string }[]>();
  /**
   * The per-session task list (`todowrite`/`todoread`).
   *
   * Lives on the controller rather than in the zustand store or on the pane, for the same reason
   * the abort controllers do: it must survive an AgentPane unmount. A list that reset when the
   * user switched away from the AI tab would be worse than no list — the model would keep
   * planning against something that had silently vanished.
   */
  private readonly todos = new Map<string, TodoStore>();
  private readonly usageMap = new Map<string, UsageTotals>();
  /** handoff §3: the LAST run's measured phase totals, per session. */
  private readonly phasesMap = new Map<string, LatencyPhases>();
  private readonly listeners = new Set<() => void>();

  /* ── run-status subscription (drives the busy glyph / rail badge) ─────────── */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* a bad subscriber must not break run bookkeeping */
      }
    }
  }
  /** This session's task list, created on first use. */
  todoStore(sid: string): TodoStore {
    let store = this.todos.get(sid);
    if (!store) {
      store = new TodoStore();
      this.todos.set(sid, store);
    }
    return store;
  }

  /** Sessions actively looping (NOT the ones suspended awaiting human approval). */
  runningIds(): string[] {
    return [...this.abort.keys()].filter((sid) => !this.awaiting.has(sid));
  }
  isRunning(sid: string): boolean {
    return this.abort.has(sid) && !this.awaiting.has(sid);
  }

  /* ── the loop lifecycle (owned here, not on the pane) ─────────────────────── */
  /**
   * Begin a run for `sid`: SUPERSEDE any prior run for this tab (abort it + drop its
   * paused/proposed state), mint the AC we run under, mark the session busy, then drive
   * `runAgentLoop` to completion. Returns when the loop settles (done or paused) — but the
   * awaited promise is NOT tied to any component, so it runs to completion even if every
   * AgentPane has unmounted. Store writes go through lifecycle-free `useAiSessionStore`
   * actions, so the transcript keeps growing with zero components mounted.
   */
  async start(sid: string, params: StartParams): Promise<void> {
    const ac = this.beginRun(sid);
    useAiSessionStore.getState().setBusy(sid, true);
    const deps: AgentLoopDeps = { ...params.deps, signal: ac.signal };
    try {
      await (params.run ?? ((m, d) => this.drive(sid, m, d)))(params.messages, deps);
    } catch (e) {
      this.surfaceError(sid, ac, e);
    }
    this.finalize(sid, ac);
  }

  /**
   * Drive ONE turn on core's loop.
   *
   * The thread is built from the pane's message list and then handed to core, which MUTATES
   * it as the turn goes multi-round. We do not read it back: the pane's transcript is fed by
   * the streaming callbacks, and the next `start` rebuilds the thread from that transcript —
   * one source of truth for what the conversation is, rather than two that must agree.
   */
  private async drive(sid: string, messages: LoopMessages, deps: AgentLoopDeps): Promise<void> {
    const thread: Thread = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    // §3 latency attribution, accumulated across every round of THIS run.
    const startedAt = Date.now();
    let modelMs = 0;
    let loadMs = 0;
    let toolsMs = 0;

    const llm = createRendererLlmClient({
      endpoint: deps.endpoint,
      neverSendToCloud: deps.neverSendToCloud,
      signal: deps.signal,
      ...(deps.effort ? { effort: deps.effort } : {}),
      phases: {
        addModelMs: (ms) => {
          modelMs += ms;
        },
        addLoadMs: (ms) => {
          loadMs += ms;
        },
        ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
      },
    });

    // Built once, not twice: the sub-agent's tuning is DERIVED from this one, and deriving it
    // from a second identical-looking object is how a child comes to run under a gate mode or
    // an authorization level the parent never had.
    // The MCP catalogue is read PER TURN, not once at startup: a user can connect, disconnect
    // or remove a server between two messages from the Extensions panel, and a list captured at
    // startup would go stale invisibly — the model would keep being offered tools that no
    // longer exist. Fail-soft: a broken MCP surface must not stop an ordinary turn.
    const mcpTools = await this.mcpToolDefs(deps);
    // "Don't ask again", finally meaning it. The store is hydrated per turn from the SAME
    // `<config>/grants.json` the CLI writes, so a grant given in the terminal is honoured here
    // and vice versa — and one given here survives a restart.
    const grants = await this.loadGrants(deps);
    // Task #5 (desktop parity): sub-agent personas from markdown, read PER TURN for the same
    // reason mcpTools is — a persona file dropped into ~/.prometheus/agents mid-session should
    // be spawn-able on the very next message, not after a restart.
    const personas = await this.agentFilePersonas(deps);
    // The posture is read PER TURN from the same store the level comes from, so switching to
    // plan mode takes effect on the next message rather than on the next app launch.
    const auth = useAuthorisationStore.getState();
    /**
     * The user's lifecycle hooks, read PER TURN from main for the same reason `mcpTools` and
     * `personas` are: a hook added to settings mid-session must apply on the next message, not
     * after a restart. Main owns both the list and the spawn — the renderer only proxies.
     */
    const hooks = await listPaneHooks(deps.ide);
    const hookRunner =
      hooks.length > 0 && deps.ide ? makeIdeHookRunner(deps.ide, deps.root) : undefined;
    const tuning = agentPaneTuning(
      deps.endpoint.model ?? deps.endpoint.id,
      auth.level,
      mcpTools,
      auth.permissionMode,
      personas,
      hooks,
      hookRunner,
    );
    // Per USER TURN, shared by the whole tree — counting per parent would let a wide fan-out
    // spawn maxSpawns children at every level.
    const spawnBudget = initialBudget();
    const questionBudget = initialQuestionBudget();
    // The runner is referenced by the spawn seam below, which is built as part of it. `let` +
    // assignment is how the child gets the SAME tool runner the parent uses (it must, or the
    // child would reach tools through a different path with different guards).
    let runToolRef:
      | ((tool: ToolDef, args: Record<string, unknown>) => Promise<ToolOutcome>)
      | null = null;
    const runTool = createRendererToolRunner({
      tools: deps.tools,
      onToolNote: deps.onToolNote,
      time: async <T>(fn: () => Promise<T>): Promise<T> => {
        const t0 = Date.now();
        try {
          return await fn();
        } finally {
          toolsMs += Date.now() - t0;
        }
      },
      /**
       * Phase 6: dispatch to core's shared implementation in main.
       *
       * REPLAY, not re-dispatch. When a call was routed to a human, the task card already ran
       * it through this same channel while the turn was suspended in `confirm` — so calling
       * main again here executes it a SECOND time.
       *
       * This used to be narrowed to `run_command`, which was correct only while that was the
       * one tool a human could be asked about. Since the card began presenting every system
       * tool the broker routes to a human, the narrowing became a bug: `propose_elevated` and
       * `job_kill` carry no annotations, so NO authorization level auto-approves them and they
       * always take the card path — and at level 0 (`yes:false`) so does every read. Running
       * `job_kill` twice is noise; running an elevated proposal twice is not.
       *
       * The stash is keyed by TOOL NAME as well as session. One entry exists at a time (core
       * asks about each call in turn and dispatches immediately after), but a card that is
       * approved for a call the loop then abandons would otherwise leave a result that the
       * NEXT tool would happily replay as its own.
       */
      /**
       * The task list — agent memory, never the filesystem.
       *
       * Dispatched in the renderer because there is nothing to run: it mutates an in-memory
       * store and renders a status line. Sending it over IPC to main would add a round trip and
       * a second place for the list to live.
       */
      todo: (name, args) => {
        const out = runTodoTool(name, args, this.todoStore(sid));
        if (out) deps.onToolNote(`▤ ${todoSummary(this.todoStore(sid).list())}`);
        return out;
      },
      /**
       * `notebook_edit` — dispatched in the RENDERER (the ipynb pipeline lives there), with the
       * SAME replay discipline `systemTool` uses.
       *
       * The tool is `destructiveHint`, so no authorization level auto-approves it and every
       * call reaches a human task card — which has already RUN the edit by the time core calls
       * the tool runner. Re-dispatching would overwrite the cell twice; for an idempotent
       * source replacement that is invisible, which is precisely why it needs pinning.
       */
      notebook: (name, args) => {
        const done = this.approvedCommand.get(sid);
        if (done) this.approvedCommand.delete(sid);
        const replay = claimCardResult(done, name);
        if (replay) return Promise.resolve({ ok: replay.ok, summary: replay.summary });
        return runNotebookTool(name, args);
      },
      systemTool: async (name, args) => {
        const done = this.approvedCommand.get(sid);
        if (done) this.approvedCommand.delete(sid); // claimed or stale, it is spent either way
        const replay = claimCardResult(done, name);
        if (replay) return replay;
        const r = deps.root
          ? await deps.ide?.systemTool({
              name,
              args,
              cwd: deps.root,
              // The level travels with the call so main can confine `run_command` to what the
              // pill already permits — without it the OS sandbox assumes the safe default and
              // denies the network at every level. Read here (not captured) for the same
              // reason the tuning is: the pill can move mid-turn.
              authLevel: useAuthorisationStore.getState().level,
            })
          : undefined;
        return r ?? { ok: false, summary: `"${name}" is unavailable in this environment` };
      },
      /**
       * The `prometheus_*` verbs, through the engine in main.
       *
       * The same REPLAY discipline as `systemTool`, and it matters more here: the four
       * mutators always reach a task card (destructiveHint is never auto-approvable), so the
       * card has already RUN the verb by the time core calls the tool runner. Re-dispatching
       * would install twice.
       *
       * No `cwd` is sent — these verbs are machine-global, and passing a workspace root would
       * suggest a scope the engine does not apply.
       */
      engineTool: async (name, args) => {
        const done = this.approvedCommand.get(sid);
        if (done) this.approvedCommand.delete(sid);
        const replay = claimCardResult(done, name);
        if (replay) return replay;
        const r = await deps.ide?.engineTool({ name, args });
        return r ?? { ok: false, summary: `"${name}" is unavailable in this environment` };
      },
      /**
       * `spawn_agent` — one nested turn on the SAME loop, the same LLM client and the same
       * tool runner, under a tuning core derives from the parent's.
       *
       * Every safety property is core's and none of it is re-decided here: `canSpawn` refuses
       * past the depth/spawn budget, and `childTuning` inherits the parent's gate mode and deny
       * list, adds `spawn_agent` to the child's denies so it cannot spawn in turn, and for a
       * read-only role denies every parent tool that is not annotated read-only. Only the
       * child's final TEXT crosses back — its events are consumed inside `runSubagent`, so the
       * transcript shows "delegated X, got Y" rather than a second interleaved tool stream.
       */
      spawn: async (args) => {
        const decision = canSpawn(spawnBudget);
        if (!decision.allowed) return { ok: false, summary: decision.reason };
        const task = typeof args.task === "string" ? args.task.trim() : "";
        if (!task) return { ok: false, summary: "spawn_agent: `task` is required" };
        /**
         * Task #5 (desktop parity): `role` may be a BUILT-IN name or a loaded persona — the
         * SAME resolution the CLI's `spawnSubagent` does. `isSubagentRole` stays the real gate
         * (a persona can only ever pick among the built-in roles as its `base`, and a project
         * persona is already forced to a read-only one by `loadAgentFile`'s clamp).
         */
        const requested = typeof args.role === "string" ? args.role : "";
        const persona = isSubagentRole(requested)
          ? undefined
          : personas.find((p) => p.name === requested);
        const role = isSubagentRole(requested) ? requested : (persona?.base ?? "explore");
        spawnBudget.spawned += 1;
        const exposed = exposedTools(tuning.tools);
        const base = childTuning(
          tuning,
          role,
          task,
          exposed,
          typeof args.maxRounds === "number" ? args.maxRounds : undefined,
          // The child's preamble is assembled against the SAME endpoint facts this turn already
          // has (`deps.effort` is the resolution `createRendererLlmClient` above was just given)
          // rather than `childTuning`'s permanent "unknown"/no-window placeholder — without
          // `effortMechanism` specifically, a child on a model with a WORKING native mechanism
          // got the textual effort nudge on top of it too, double-injecting the tier.
          {
            locality: deps.endpoint.locality,
            contextWindow: deps.endpoint.contextWindow,
            ...(deps.effort ? { effortMechanism: deps.effort.mechanism } : {}),
          },
        );
        // A persona layers on top of the tuning the ROLE already produced — it can only ADD
        // denies and ADD prompt text, never undo either. `childTuning` has already applied the
        // parent's deny list, the read-only narrowing and the `yes` rule before this runs.
        const child = persona
          ? {
              ...base,
              systemPrompt: personaSystemPrompt(persona, task),
              tools: {
                ...base.tools,
                deny: [...new Set([...base.tools.deny, ...personaDeny(persona, exposed)])],
              },
            }
          : base;
        const label = persona ? `${persona.name} (${persona.scope})` : role;
        deps.onToolNote(`⤷ ${label}: ${task}`);
        // `depth` tracks how many spawns are LIVE right now (see the CLI's matching comment on
        // its own `spawnSubagent`) — incremented for exactly this child's turn and decremented
        // once it returns, so `canSpawn` has a real backstop independent of `childTuning`'s
        // deny-list entry for `spawn_agent`.
        spawnBudget.depth += 1;
        try {
          const out = await runSubagent((t, tune, d) => runAgentTurn(t, tune, d), child, task, {
            llm,
            runTool: (tool, a) =>
              runToolRef
                ? runToolRef(tool, a)
                : Promise.resolve({ ok: false, summary: "the tool runner is not ready" }),
            // The CHILD's exposed tools, not the parent's — see `confirmToolCall`'s param doc.
            confirm: (call) => this.confirmToolCall(sid, deps, call, exposedTools(child.tools)),
            // Point 6b: a sub-agent is exactly the surface most likely to touch untrusted
            // content — it must not run with the canary tripwire silently disabled just because
            // it's a delegated turn.
            onCanaryTripped: (info) => {
              void deps.ide?.canaryTrip?.(info);
            },
          });
          deps.onToolNote(`⤶ sub-agent done (${out.toolCalls} tool call(s))`);
          return { ok: out.ok, summary: out.text };
        } catch (err) {
          /**
           * A sub-agent that THROWS is a failed tool call, not a failed turn.
           *
           * This block was `try`/`finally` with no `catch`, so an exception from `runSubagent`
           * — a provider rejecting, a transport dying mid-delegation, a tool runner that is not
           * ready — escaped the `spawn_agent` handler instead of becoming its result. The
           * parent model never learned the delegation failed and could not adapt; the user saw
           * the turn die rather than the sub-agent fail.
           *
           * The CLI has always returned the failure as a tool result
           * (`apps/cli/src/session/agent-runtime.ts:4394`). Same shape here, deliberately:
           * `ok:false` plus a summary the model can read and act on.
           */
          const message = err instanceof Error ? err.message : String(err);
          deps.onToolNote(`⤶ sub-agent failed: ${message}`);
          return { ok: false, summary: `sub-agent failed: ${message}` };
        } finally {
          spawnBudget.depth -= 1;
        }
      },
      /**
       * `question` — a free-text answer from the human, mid-turn.
       *
       * The budget is per TURN, not per call: a model that can ask forever will, and three is
       * the point at which asking again is worse than choosing an interpretation and saying so.
       */
      /** One MCP tool call, forwarded to the server main holds the transport for. */
      mcpTool: async (serverId, tool, args) => {
        const r = await deps.mcp?.agentCall({ serverId, tool, args });
        return r ?? { ok: false, summary: `MCP server "${serverId}" is unavailable` };
      },
      askUser: async (args) => {
        const allowed = canAsk(questionBudget);
        if (!allowed.allowed) return { ok: false, summary: allowed.reason };
        const prompt = renderQuestion(args);
        if (!prompt) return { ok: false, summary: "question: `question` is required" };
        questionBudget.asked += 1;
        const answer = await this.askQuestion(sid, deps, prompt);
        return { ok: true, summary: renderAnswer(answer) };
      },
    });
    runToolRef = runTool;

    try {
      await runCoreAgentTurn(thread, tuning, llm, runTool, {
        // The run's cancel, into the LOOP — not only into the model stream. Without it,
        // pressing stop left the loop free to start another round and run more tools.
        signal: deps.signal,
        onText: deps.onText,
        onTurnComplete: deps.onTurnComplete,
        onToolNote: deps.onToolNote,
        // Thinking + watchdog lines are LIVE feedback only. They go to the session's
        // EPHEMERAL fields, never `turns`: reasoning is the model's scratch work, and
        // folding it into the transcript would both replay it as an answer after a reload
        // and feed it back to the model as prior context on the next turn.
        //
        // Surfacing it at all is the point — a reasoning model streams nothing on
        // `content` while it thinks, so without this the pane shows a blank turn for the
        // whole thinking phase and the run reads as hung (§9 "reasoning surfacing").
        onReasoning: (d) => useAiSessionStore.getState().appendThinking(sid, d),
        onStatus: (t) => useAiSessionStore.getState().setStatus(sid, t),
        onCapped: (rounds) =>
          deps.onToolNote(
            `(reached the ${rounds}-round limit with work still queued — send "continue" to resume)`,
          ),
        // Point 6b: the loop detected its own planted token in the model's output. Forward to
        // MAIN, which owns the audit disk — a harness/older preload without `canaryTrip` just
        // drops it (the trip already happened; this is only the record of it).
        onCanaryTripped: (info) => {
          void deps.ide?.canaryTrip?.(info);
        },
        // `withRememberedGrants` sits UNDER the broker: it can only remove a question the
        // broker already routed to a human, never add an approval the broker refused. A `deny`
        // grant still wins, structurally, over any allow.
        confirm: grants
          ? withRememberedGrants(
              (call) => this.confirmToolCall(sid, deps, call, exposedTools(tuning.tools)),
              grants,
              {
                workspaceRoot: deps.root ?? ".",
                onRemember: (subject, scope) => {
                  // Only the two scopes that outlive the session are worth writing; `once` and
                  // `session` have already expired by the time anything could read them back.
                  if (scope !== "project" && scope !== "user") return;
                  void deps.ide?.grantsAdd?.({
                    subject,
                    decision: "allow",
                    scope,
                    ...(scope === "project" && deps.root ? { root: deps.root } : {}),
                  });
                  deps.onToolNote(`🔓 remembered: ${subject} (${scope})`);
                },
                onAutoApprove: (subject) =>
                  deps.onToolNote(`↩ auto-approved ${subject} (remembered)`),
              },
            )
          : (call) => this.confirmToolCall(sid, deps, call, exposedTools(tuning.tools)),
      });
    } finally {
      useAiSessionStore.getState().clearEphemeral(sid);
      if (deps.onPhases) {
        const total = Date.now() - startedAt;
        // `wrapper` is the residual, so the four legs always sum to real elapsed time and
        // the bar cannot lie about where a slow run went.
        deps.onPhases({
          model: modelMs,
          load: loadMs,
          tools: toolsMs,
          wrapper: Math.max(0, total - modelMs - loadMs - toolsMs),
        });
      }
      this.approvedCommand.delete(sid);
    }
  }

  /**
   * The persisted grants, as a live store.
   *
   * Read per TURN rather than once: a user can add a grant from the terminal between two
   * messages, and a store captured at startup would go stale invisibly — which is the exact
   * failure ("I said always and it asked again") this path exists to end. Fail-soft: no grants
   * surface simply means every call is asked, which is the safe direction.
   */
  private async loadGrants(deps: AgentLoopDeps): Promise<ScopedPermissionStore | null> {
    if (!deps.ide?.grantsList) return null;
    try {
      const res = await deps.ide.grantsList();
      if (!res.ok) return null;
      const store = new ScopedPermissionStore();
      // Through `add()`, never around it: it is what refuses an over-broad subject, and a
      // rehydrated grant must pass the same door a live one does.
      for (const g of res.grants) store.add(g as never);
      return store;
    } catch {
      return null;
    }
  }

  /**
   * The tool defs the configured MCP servers currently publish.
   *
   * Built HERE from descriptors rather than received as defs, because a `ToolDef` holds a
   * function and cannot cross IPC. `allMcpToolDefs` is core's own — the same one the CLI uses —
   * so a server's tools carry identical names, schemas and annotations on both surfaces. It
   * also does the filtering that matters: a server that is disabled, not ready, or carries a
   * blocking nemesis verdict publishes NOTHING.
   */
  private async mcpToolDefs(deps: AgentLoopDeps): Promise<ToolDef[]> {
    if (!deps.mcp) return [];
    try {
      const res = await deps.mcp.agentTools();
      if (!res.ok) return [];
      return allMcpToolDefs(
        res.servers.map((s: McpAgentServer) => ({
          id: s.id,
          label: s.label,
          enabled: s.enabled,
          health: s.health,
          ...(s.verdict ? { gate: { verdict: s.verdict } } : {}),
          capabilities: { tools: s.tools, resources: false, prompts: false },
        })) as never,
      );
    } catch {
      // Fail-soft on purpose: an MCP surface that errors must not take an ordinary turn with it.
      return [];
    }
  }

  /**
   * Task #5 (desktop parity): the sub-agent personas discovered for this workspace, already
   * CLAMPED by scope in MAIN (`@prometheus/core/agent-files`'s `loadAgentFile` — the SAME
   * function the CLI calls) before the list ever crosses IPC. Fail-soft: no `ide.agentFilesList`
   * seam, no workspace root, or an errored call all mean "no personas", never a broken turn.
   */
  private async agentFilePersonas(deps: AgentLoopDeps): Promise<LoadedAgent[]> {
    if (!deps.ide?.agentFilesList || !deps.root) return [];
    try {
      const res = await deps.ide.agentFilesList(deps.root);
      return res.ok ? res.personas : [];
    } catch {
      return [];
    }
  }

  /**
   * Suspend the turn on a QUESTION card and resolve with what the human typed.
   *
   * The same machinery as a task card rather than a modal, and that is the deliberate part: a
   * modal mid-run steals focus from whatever the user is doing while the agent works, and a
   * question is not urgent — it is a message. Cancelling answers with the empty string, which
   * core's `renderAnswer` turns into "the user gave no answer, proceed with the most reasonable
   * interpretation", so a dismissed question never hangs the turn.
   */
  private askQuestion(sid: string, deps: AgentLoopDeps, prompt: string): Promise<string> {
    if (!deps.tools.askQuestion) return Promise.resolve("");
    deps.onToolNote(`? ${prompt}`);
    deps.tools.askQuestion(prompt);
    const cards = this.proposed.get(sid) ?? [];
    const card = cards[cards.length - 1];
    if (!card) return Promise.resolve("");

    const entry: AwaitingEntry = this.awaiting.get(sid) ?? {
      ac: this.abort.get(sid) ?? new AbortController(),
      cards: [],
      pending: new Map(),
    };
    entry.cards.push(card);
    this.awaiting.set(sid, entry);
    useAiSessionStore.getState().setBusy(sid, false);
    this.notify();

    return new Promise((resolve) => {
      entry.pending.set(card.id, (r: CommandResult) => {
        entry.pending.delete(card.id);
        if (entry.pending.size === 0) {
          this.awaiting.delete(sid);
          useAiSessionStore.getState().setBusy(sid, true);
        }
        this.notify();
        resolve(r.denied ? "" : (r.answer ?? ""));
      });
      // A stop or a new prompt while suspended must not leave the generator awaiting forever.
      deps.signal.addEventListener(
        "abort",
        () => entry.pending.get(card.id)?.({ command: prompt, denied: true }),
        {
          once: true,
        },
      );
    });
  }

  /**
   * Answer core's `confirm` for a tool the §4.3 broker routed to a human.
   *
   * `propose_edit` / `write_file` approve IMMEDIATELY, and that is deliberate: they do not
   * touch disk. They enqueue a proposal into the diff review, where the user approves the
   * actual hunks, and main's working-set path guard refuses anything outside the workspace
   * regardless. Blocking here would ask the user "may the agent propose an edit?" — a
   * question with no security content — and then ask the real question a moment later.
   *
   * `run_command` DOES touch the machine, so it suspends here until the human clicks Run or
   * Deny on its task card.
   */
  private confirmToolCall(
    sid: string,
    deps: AgentLoopDeps,
    call: ToolCall,
    /**
     * The tools exposed to THIS turn, for the annotation lookup the ladder needs.
     *
     * Passed in rather than read from a field because a `spawn_agent` child runs under its own
     * narrowed tuning — grading a child's call against the parent's tool list would classify
     * a tool the child cannot even see.
     */
    exposed: readonly ToolDef[] = [],
  ): Promise<ConfirmResult> {
    if (call.name === "propose_edit" || call.name === "write_file") return Promise.resolve(true);
    // The membership check is the pane's ALLOW-LIST, not its `extra` array — this is the guard
    // that fails SILENTLY, and checking `extra` was subtly wrong: an allowed name may resolve
    // from core's BASE catalogue instead (`propose_edit`, `write_file`, `web_fetch` all do), so
    // `web_fetch` would have been shown to the model, proposed, and denied right here with
    // "not available in the editor" and no other symptom.
    // An MCP tool is not in the static allow-list — it comes from a server the user configured,
    // and the per-turn tuning is what admits it. Checking only the static list here would deny
    // every MCP call at the confirm step, AFTER the model was shown the tool.
    if (!AGENT_PANE_ALLOW.includes(call.name) && !isMcpToolName(call.name)) {
      return Promise.resolve({
        approved: false,
        reason: `"${call.name}" is not available in the editor`,
      });
    }
    /**
     * The autonomy ladder, AFTER the allow-list and before the card.
     *
     * Order is the point. The allow-list is a membership question ("may this surface run this
     * tool at all") and must be answered first — a level of 7 does not admit a tool the editor
     * does not expose. The ladder is a frequency question ("must a human be asked this time"),
     * so it comes second, and a refusal here is never a denial: it falls through to the card,
     * which is the same informed decision as before.
     *
     * The pane previously had no ladder at all and asked at every level, which made the
     * persisted authorisation setting mean one thing in the terminal and another here. See
     * `autoApprovesToolCall`.
     */
    const annotations = exposed.find((t) => t.name === call.name)?.annotations;
    if (autoApprovesToolCall(call, annotations)) return Promise.resolve(true);
    /**
     * Phase 6: the card presents ANY system tool the broker routed to a human, not only
     * `run_command`.
     *
     * The old shape rejected everything else outright, which was correct when Studio had
     * four tools and only one of them could reach a human. With core's set that same line
     * would deny `propose_elevated` — a tool NO authorization level auto-approves, so it
     * would have been permanently unreachable in the GUI while working in the CLI. That is
     * precisely the surface drift this phase exists to end.
     *
     * `run_command` shows the command line; everything else shows the tool and its
     * arguments, which is what the human is actually being asked about.
     */
    const command =
      call.name === "run_command"
        ? String(call.args.command ?? "")
        : `${call.name} ${JSON.stringify(call.args)}`;
    // proposeCommand mints the task card AND registers it via recordProposed.
    deps.onToolNote(deps.tools.proposeCommand(command, call.name, call.args));
    const cards = this.proposed.get(sid) ?? [];
    const card = cards[cards.length - 1];
    if (!card) return Promise.resolve({ approved: false, reason: "could not present the command" });

    const entry: AwaitingEntry = this.awaiting.get(sid) ?? {
      ac: this.abort.get(sid) ?? new AbortController(),
      cards: [],
      pending: new Map(),
    };
    entry.cards.push(card);
    this.awaiting.set(sid, entry);
    useAiSessionStore.getState().setBusy(sid, false);
    this.notify();

    return new Promise((resolve) => {
      entry.pending.set(card.id, (r: CommandResult) => {
        entry.pending.delete(card.id);
        if (entry.pending.size === 0) {
          this.awaiting.delete(sid);
          useAiSessionStore.getState().setBusy(sid, true);
        }
        this.notify();
        if (r.denied) {
          resolve({ approved: false, reason: "the user declined to run this command" });
          return;
        }
        // "Always allow" — the answer that makes the grants file mean something. It rides the
        // card's result rather than a second channel, so approval and memory are ONE decision
        // and cannot disagree.
        if (r.remember) {
          this.approvedCommand.set(sid, { tool: call.name, result: r });
          resolve({ approved: true, remember: r.remember });
          return;
        }
        // Stash the outcome for the tool runner, which core calls straight after this —
        // tagged with the tool it belongs to so it can never be claimed by a different call.
        this.approvedCommand.set(sid, { tool: call.name, result: r });
        resolve(true);
      });
      // A stop / new prompt while suspended must not leave the generator awaiting forever.
      deps.signal.addEventListener(
        "abort",
        () => resolve({ approved: false, reason: "cancelled" }),
        { once: true },
      );
    });
  }

  /** Mint + register a fresh AC, superseding (aborting) any prior run for this session. */
  private beginRun(sid: string): AbortController {
    this.abort.get(sid)?.abort(); // supersede: cancel the prior run for THIS tab
    this.awaiting.delete(sid);
    this.approvedCommand.delete(sid);
    this.proposed.delete(sid);
    const ac = new AbortController();
    this.abort.set(sid, ac);
    this.notify();
    return ac;
  }

  /**
   * Settle a run: retire the AC + proposed ledger and clear busy. There is no longer a
   * "paused" outcome to stash — a run waiting on a task card never returned from the loop
   * in the first place, so reaching here means the turn is genuinely over. Only clobbers
   * state if `ac` is STILL the current run (a newer supersede-run must never be reaped by
   * an older run's late settle).
   */
  private finalize(sid: string, ac: AbortController): void {
    if (this.abort.get(sid) !== ac) return; // superseded mid-flight → the new run owns state
    this.abort.delete(sid);
    this.awaiting.delete(sid);
    this.approvedCommand.delete(sid);
    this.proposed.delete(sid);
    useAiSessionStore.getState().setBusy(sid, false);
    this.notify();
  }

  /**
   * The loop threw. Preserve the "aborted turn surfaces a committed (possibly-empty) turn,
   * never a silently-hung spinner; a real error surfaces a FAILED turn" rule (APP-056 gotcha,
   * relocated from AgentPane): commit whatever streamed; an ABORT (user cancel / supersede)
   * is expected and adds no error turn, a real error appends a ⚠ failed turn. Guarded by the
   * ac identity so a stale run never writes over a newer supersede-run's transcript.
   */
  private surfaceError(sid: string, ac: AbortController, e: unknown): void {
    const store = useAiSessionStore.getState();
    store.commitStreaming(sid);
    if (this.abort.get(sid) === ac && !ac.signal.aborted) {
      store.pushTurn(sid, {
        role: "assistant",
        content: `⚠ request failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  /**
   * USER cancel (■ stop / tab close / turn revert): abort + drop awaiting/pending state.
   *
   * The controller entry is deliberately NOT deleted here. `finalize` is what clears the store's
   * `busy` flag, and it is guarded by `this.abort.get(sid) !== ac` so a superseded run can never
   * reap a newer one's state. Deleting the entry here made that guard fail for the run being
   * cancelled: the aborted run reached `finalize`, found `undefined !== ac`, and returned before
   * `setBusy(sid, false)` — so `busy` stayed true forever. The composer, the Send button and
   * `send()` itself all key off that flag, so pressing ◼ Stop permanently disabled the chat tab
   * it was meant to interrupt; the only ways out were closing the tab, a session restore, a
   * destructive ⤺ revert, or reloading the app.
   *
   * Leaving the entry is safe in both directions: `start` runs `finalize` unconditionally after
   * its try/catch, so an aborted run always reaches it and cleans up; and if the user starts a
   * NEW run first, `beginRun` replaces the entry and the stale run's guard correctly skips.
   */
  cancel(sid: string): void {
    this.abort.get(sid)?.abort();
    // Resolve any suspended confirm as DENIED before dropping the entry, or the generator
    // sits on a promise nobody will ever settle and the turn leaks.
    const entry = this.awaiting.get(sid);
    if (entry) {
      for (const resolve of [...entry.pending.values()]) resolve({ command: "", denied: true });
    }
    this.awaiting.delete(sid);
    this.approvedCommand.delete(sid);
    this.proposed.delete(sid);
    this.notify();
  }

  /* ── the human's answer to a task card ────────────────────────────────────── */

  /** Is `sid` suspended waiting for a task-card answer? */
  isAwaiting(sid: string): boolean {
    return this.awaiting.has(sid);
  }

  recordProposed(sid: string, card: { id: string; command: string }): void {
    const arr = this.proposed.get(sid) ?? [];
    arr.push(card);
    this.proposed.set(sid, arr);
  }

  /**
   * Record a command's Run/Deny result, releasing the suspended `confirm`.
   *
   * Unlike the fork's `resolveCommand`, this does NOT have to wait for every proposed
   * command before continuing: core asks about each call in turn, so each card answers
   * exactly one await.
   */
  resolveCommand(sid: string, cardId: string, result: CommandResult): void {
    this.awaiting.get(sid)?.pending.get(cardId)?.(result);
  }

  /* ── token usage (survives unmount; drives the spend meter) ───────────────── */
  /** Store the phase totals for `sid`'s most recent run (handoff §3). */
  recordPhases(sid: string, phases: LatencyPhases): void {
    this.phasesMap.set(sid, phases);
    this.notify();
  }

  /** The last run's phase totals for `sid`, or undefined if none has settled yet. */
  getPhases(sid: string): LatencyPhases | undefined {
    return this.phasesMap.get(sid);
  }

  recordUsage(
    sid: string,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number },
  ): void {
    const prev = this.usageMap.get(sid) ?? emptyTotals();
    // local endpoints are free (null price → tokens-only); a cloud price is unknown here.
    this.usageMap.set(sid, accumulateUsage(prev, usage, null));
    this.notify();
  }
  usageFor(sid: string): UsageTotals {
    return this.usageMap.get(sid) ?? emptyTotals();
  }
  clearUsage(sid: string): void {
    this.usageMap.delete(sid);
    this.notify();
  }
}

/** The single renderer-wide run controller (survives every AgentPane unmount). */
export const agentRuns = new AgentRunController();

// Vite HMR: a module swap would orphan in-flight AbortControllers (dev only). Cancel the
// running ids on dispose so a hot edit never leaves phantom "stuck running" tabs. Typed via
// a local cast (the renderer tsconfig doesn't pull vite/client), undefined outside dev.
const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
if (hot) {
  hot.dispose(() => {
    for (const sid of agentRuns.runningIds()) agentRuns.cancel(sid);
  });
}
