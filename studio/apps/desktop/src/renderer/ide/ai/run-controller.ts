/**
 * ai/run-controller.ts — the MODULE-LEVEL agent run controller (APP-056).
 *
 * In-flight agent runs used to live on the AgentPane component (an abort map + the loop
 * invocation), so leaving the AI pane ABORTED every run. This singleton owns that state
 * OUTSIDE React — the abort controllers, the `runAgentLoop`/`resumeAgentLoop` invocation,
 * the paused/pending-command state, the per-session token usage, and the run-status
 * subscribers. All transcript/stream mutations still flow through `useAiSessionStore`
 * actions (already lifecycle-free), so a run keeps progressing to completion with ZERO
 * components mounted, and a returning pane reattaches to the live store state automatically.
 *
 * Abort is now ONLY ever user-initiated (`cancel`) or a supersede-restart (`start` cancels
 * the prior run for the same session). No unmount/cleanup path calls `.abort()`.
 *
 * C5: imports ONLY PURE renderer modules (agent-loop / usage-cost) + the zustand store
 * (lifecycle-free via `getState()`) — never the `@prometheus/core` barrel.
 */
import { useAiSessionStore } from "../state/stores.js";
import {
  type AgentLoopDeps,
  type AgentLoopOutcome,
  type CommandResult,
  resumeAgentLoop,
  runAgentLoop,
} from "./agent-loop.js";
import { type UsageTotals, accumulateUsage, emptyTotals } from "./usage-cost.js";

/** The message list runAgentLoop consumes (system + prior turns + new user turn). */
type LoopMessages = Parameters<typeof runAgentLoop>[0];
/** Injectable loop runner (defaults to `runAgentLoop`) — lets tests script a turn. */
type LoopRunner = (messages: LoopMessages, deps: AgentLoopDeps) => Promise<AgentLoopOutcome>;

/** What the component hands `start`: the messages + the deps MINUS the signal (we mint it). */
export interface StartParams {
  messages: LoopMessages;
  deps: Omit<AgentLoopDeps, "signal">;
  /** test seam: override the loop runner (defaults to the real `runAgentLoop`). */
  run?: LoopRunner;
}

/** A paused run awaiting the human's Run/Deny on each proposed command. */
export interface PausedEntry {
  paused: Extract<AgentLoopOutcome, { status: "paused" }>;
  deps: AgentLoopDeps;
  ac: AbortController;
  cards: { id: string; command: string }[];
  results: (CommandResult | undefined)[];
}

class AgentRunController {
  private readonly abort = new Map<string, AbortController>();
  private readonly paused = new Map<string, PausedEntry>();
  private readonly proposed = new Map<string, { id: string; command: string }[]>();
  private readonly usageMap = new Map<string, UsageTotals>();
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
  /** Sessions actively looping (NOT the ones paused for human approval). */
  runningIds(): string[] {
    return [...this.abort.keys()].filter((sid) => !this.paused.has(sid));
  }
  isRunning(sid: string): boolean {
    return this.abort.has(sid) && !this.paused.has(sid);
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
    const runner = params.run ?? runAgentLoop;
    let outcome: AgentLoopOutcome | undefined;
    try {
      outcome = await runner(params.messages, deps);
    } catch (e) {
      this.surfaceError(sid, ac, e);
    }
    this.finalize(sid, outcome, deps, ac);
  }

  /** Mint + register a fresh AC, superseding (aborting) any prior run for this session. */
  private beginRun(sid: string): AbortController {
    this.abort.get(sid)?.abort(); // supersede: cancel the prior run for THIS tab
    this.paused.delete(sid);
    this.proposed.delete(sid);
    const ac = new AbortController();
    this.abort.set(sid, ac);
    this.notify();
    return ac;
  }

  /**
   * Settle a run: PAUSED → stash the paused state (keyed by sid; the ac stays live so a
   * stop/new-prompt still aborts the resume) and wait for the human to Run/Deny each card.
   * DONE → retire the AC + proposed ledger. Busy clears in both cases (nothing is running);
   * a resume flips it back on. Only clobbers state if `ac` is STILL the current run (a newer
   * supersede-run must never be reaped by an older run's late settle).
   */
  private finalize(
    sid: string,
    outcome: AgentLoopOutcome | undefined,
    deps: AgentLoopDeps,
    ac: AbortController,
  ): void {
    if (this.abort.get(sid) !== ac) return; // superseded mid-flight → the new run owns state
    if (outcome?.status === "paused") {
      const cards = this.proposedFor(sid, outcome.pending.length);
      this.paused.set(sid, {
        paused: outcome,
        deps,
        ac,
        cards,
        results: cards.map(() => undefined),
      });
    } else {
      this.abort.delete(sid);
      this.proposed.delete(sid);
    }
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

  /** USER cancel (■ stop / tab close / turn revert): abort + drop paused/pending state. */
  cancel(sid: string): void {
    this.abort.get(sid)?.abort();
    this.abort.delete(sid);
    this.paused.delete(sid);
    this.proposed.delete(sid);
    this.notify();
  }

  /* ── pause → resume (owned here so the resume loop survives unmount too) ───── */
  getPaused(sid: string): PausedEntry | undefined {
    return this.paused.get(sid);
  }
  recordProposed(sid: string, card: { id: string; command: string }): void {
    const arr = this.proposed.get(sid) ?? [];
    arr.push(card);
    this.proposed.set(sid, arr);
  }
  private proposedFor(sid: string, n: number): { id: string; command: string }[] {
    return (this.proposed.get(sid) ?? []).slice(-n);
  }

  /** Record a command's Run/Deny result; resume the loop once every pending is resolved. */
  resolveCommand(sid: string, cardId: string, result: CommandResult): void {
    const entry = this.paused.get(sid);
    if (!entry) return;
    const idx = entry.cards.findIndex((c) => c.id === cardId);
    if (idx < 0 || entry.results[idx] !== undefined) return;
    entry.results[idx] = result;
    if (entry.results.every((r) => r !== undefined)) void this.resume(sid);
  }

  /** Resume a paused session once EVERY proposed command has a Run/Deny result. */
  private async resume(sid: string): Promise<void> {
    const entry = this.paused.get(sid);
    if (!entry || entry.results.some((r) => r === undefined)) return;
    this.paused.delete(sid);
    // abort-while-paused (stop / new prompt) → discard the resume, no zombie turn.
    if (entry.ac.signal.aborted) {
      if (this.abort.get(sid) === entry.ac) this.abort.delete(sid);
      this.notify();
      return;
    }
    useAiSessionStore.getState().setBusy(sid, true);
    this.notify();
    let outcome: AgentLoopOutcome | undefined;
    try {
      outcome = await resumeAgentLoop(entry.paused, entry.results as CommandResult[], entry.deps);
    } catch (e) {
      this.surfaceError(sid, entry.ac, e);
    }
    this.finalize(sid, outcome, entry.deps, entry.ac);
  }

  /* ── token usage (survives unmount; drives the spend meter) ───────────────── */
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
