/**
 * session/orchestrator.ts — the subagent fan-out policy for the interactive session.
 *
 * When the session runs INSIDE a live tmux session, Prometheus enters ORCHESTRATOR mode:
 * it starts with a DEFAULT of 3 subagents (roster: build · plan · explore · scout) and,
 * per prompt, the main agent (orchestrator) decides whether 3 is enough or the task is
 * complex enough to warrant more — `decideSubagentCount` is that decision, a pure,
 * dependency-free complexity heuristic (so it's deterministic + unit-testable). The
 * host announces the decision; the actual pane fan-out is the tmux multiplexer's job.
 */

/** The default subagent count when orchestrator mode is on (tmux active). */
export const DEFAULT_SUBAGENTS = 3;

/** The hard ceiling on auto-scaled subagents (keeps a runaway prompt bounded). */
export const MAX_SUBAGENTS = 8;

/** Complexity signals that justify MORE than the default subagent count. */
const COMPLEXITY_SIGNALS: readonly string[] = [
  "all ",
  "every ",
  "across",
  "entire",
  "whole",
  "refactor",
  "audit",
  "migrate",
  "comprehensive",
  "thorough",
  "exhaustive",
  "multiple",
  "each ",
  "everything",
  "end-to-end",
  "parallel",
];

/**
 * The orchestrator's decision: how many subagents should handle this prompt? Starts at
 * `base` (3 under tmux); each complexity signal + each length tier adds one, capped at
 * MAX_SUBAGENTS. A short, simple prompt stays at `base`. Pure — no I/O, no model call.
 */
export function decideSubagentCount(
  prompt: string,
  base: number = DEFAULT_SUBAGENTS,
  max: number = MAX_SUBAGENTS,
): number {
  const p = prompt.toLowerCase();
  let hits = 0;
  for (const sig of COMPLEXITY_SIGNALS) if (p.includes(sig)) hits++;
  // count "and"-joined clauses (a rough proxy for independent subtasks).
  const ands = (p.match(/\band\b/g) ?? []).length;
  if (ands >= 2) hits++;
  if (prompt.length > 280) hits++;
  if (prompt.length > 600) hits++;
  return Math.max(1, Math.min(max, base + hits));
}

/** A one-line orchestrator announcement for a turn (or "" when no fan-out is implied). */
export function orchestratorNote(prompt: string, base: number): string {
  const n = decideSubagentCount(prompt, base);
  if (n <= base) return "";
  return `orchestrator: this looks complex — scaling ${base} → ${n} subagents for this task`;
}

/* ── background agent runs: detach / list / attach / kill (CLI-034) ─────────── */

/** A background run's lifecycle state. `waiting-approval` = paused on a permission ask (CLI-033). */
export type RunState = "running" | "waiting-approval" | "done" | "failed" | "killed";

/** One sequence-numbered output chunk in a run's ring buffer. */
export interface RunEvent {
  /** monotonic per-run sequence number (the buffer→live attach seam is exact on this). */
  seq: number;
  text: string;
}

/** A serialisable snapshot of a run (for `prometheus agents` list / --json). */
export interface RunRecord {
  id: string;
  model: string;
  startedAt: string;
  settledAt?: string;
  state: RunState;
  exitSummary?: string;
  /** total bytes dropped from the head of the ring buffer (0 = nothing truncated). */
  droppedBytes: number;
}

/** Ring-buffer byte cap per run (oldest chunks drop at the head with a marker). */
export const RUN_BUFFER_CAP_BYTES = 256 * 1024;

interface RunEntry extends RunRecord {
  controller: AbortController;
  buffer: RunEvent[];
  bytes: number;
  nextSeq: number;
  subscribers: Set<(ev: RunEvent) => void>;
  onSettle: Set<(rec: RunRecord) => void>;
}

/**
 * The in-process background-run table (CLI-034). A run keeps executing (and appending to its
 * ring buffer) after the user leaves the pane; `attach` replays the buffer then streams live
 * with NO gap/dup at the seam (replay ends at seq N, the next append is N+1); `kill` fires the
 * CLI-002 AbortController. In-process only — a second `prometheus` process sees only persisted runs.
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunEntry>();
  private readonly now: () => string;
  private idSeq = 0;

  constructor(opts: { now?: () => string } = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Register a new run; returns its id. The caller feeds output via `append`. */
  register(opts: { id?: string; model: string; controller: AbortController }): string {
    const id = opts.id ?? `run-${++this.idSeq}`;
    this.runs.set(id, {
      id,
      model: opts.model,
      startedAt: this.now(),
      state: "running",
      droppedBytes: 0,
      controller: opts.controller,
      buffer: [],
      bytes: 0,
      nextSeq: 1,
      subscribers: new Set(),
      onSettle: new Set(),
    });
    return id;
  }

  /** Append one output chunk (seq-numbered), ring-capping the buffer + notifying live attachers. */
  append(id: string, text: string): void {
    const e = this.runs.get(id);
    if (!e || text.length === 0) return;
    const ev: RunEvent = { seq: e.nextSeq++, text };
    e.buffer.push(ev);
    e.bytes += Buffer.byteLength(text, "utf8");
    // ring cap: drop from the HEAD until under budget (keep at least the newest chunk).
    while (e.bytes > RUN_BUFFER_CAP_BYTES && e.buffer.length > 1) {
      const dropped = e.buffer.shift() as RunEvent;
      const n = Buffer.byteLength(dropped.text, "utf8");
      e.bytes -= n;
      e.droppedBytes += n;
    }
    // SYNC notify (no await) so the attach seam can't miss/dup an event.
    for (const sub of e.subscribers) sub(ev);
  }

  /** Move a run to a new state (records settledAt + fires onSettle for terminal states). */
  setState(id: string, state: RunState, exitSummary?: string): void {
    const e = this.runs.get(id);
    if (!e) return;
    e.state = state;
    if (exitSummary !== undefined) e.exitSummary = exitSummary;
    if (state === "done" || state === "failed" || state === "killed") {
      e.settledAt = this.now();
      for (const cb of e.onSettle) cb(this.snapshot(e));
    }
  }

  /** Kill a run: fire its AbortController (CLI-002 signal) + settle to `killed`. */
  kill(id: string): boolean {
    const e = this.runs.get(id);
    if (!e) return false;
    if (e.state !== "done" && e.state !== "failed" && e.state !== "killed") {
      try {
        e.controller.abort("killed by prometheus agents kill");
      } catch {
        /* an already-aborted controller is fine */
      }
      this.setState(id, "killed");
    }
    return true;
  }

  private snapshot(e: RunEntry): RunRecord {
    return {
      id: e.id,
      model: e.model,
      startedAt: e.startedAt,
      ...(e.settledAt ? { settledAt: e.settledAt } : {}),
      state: e.state,
      ...(e.exitSummary !== undefined ? { exitSummary: e.exitSummary } : {}),
      droppedBytes: e.droppedBytes,
    };
  }

  /** A snapshot of every run, newest-first. */
  list(): RunRecord[] {
    return [...this.runs.values()].map((e) => this.snapshot(e)).reverse();
  }

  get(id: string): RunRecord | undefined {
    const e = this.runs.get(id);
    return e ? this.snapshot(e) : undefined;
  }

  /** Subscribe to a run's SETTLE (for the TUI completion notice). Returns an unsubscribe fn. */
  onSettle(id: string, cb: (rec: RunRecord) => void): () => void {
    const e = this.runs.get(id);
    if (!e) return () => {};
    e.onSettle.add(cb);
    return () => e.onSettle.delete(cb);
  }

  /**
   * Attach to a run: returns the buffered replay (seq 1..lastSeq) + subscribes `onEvent` to
   * LIVE chunks (seq lastSeq+1..). Snapshot + subscribe happen in ONE sync block, so no event
   * lands between them — the replay/live seam is gap-free and dup-free. `unsubscribe` detaches
   * WITHOUT killing the run (Ctrl-C during attach). undefined for an unknown run.
   */
  attach(
    id: string,
    onEvent: (ev: RunEvent) => void,
  ): { replay: RunEvent[]; lastSeq: number; state: RunState; unsubscribe: () => void } | undefined {
    const e = this.runs.get(id);
    if (!e) return undefined;
    const replay = [...e.buffer];
    const lastSeq = replay.length ? (replay[replay.length - 1] as RunEvent).seq : 0;
    e.subscribers.add(onEvent);
    return { replay, lastSeq, state: e.state, unsubscribe: () => e.subscribers.delete(onEvent) };
  }
}

/** The process-wide background-run registry the session + `prometheus agents` share. */
export const runRegistry = new RunRegistry();

/** What a background run body receives: its id, an output sink, and the CLI-002 abort signal. */
export interface BackgroundRunCtx {
  id: string;
  append: (text: string) => void;
  signal: AbortSignal;
}

/**
 * Start a background run under a PER-PROVIDER concurrency slot (CLI-034): registers the run,
 * acquires the KeyedSemaphore keyed by provider, runs `body`, and settles the state
 * (done/failed) — the semaphore slot is released in the semaphore's own finally, so a
 * killed/failed run never leaks a bulkhead slot. A run killed mid-flight keeps `killed`.
 */
export function startBackgroundRun(
  registry: RunRegistry,
  acquire: (provider: string, fn: () => Promise<void>) => Promise<void>,
  opts: { model: string; provider: string; id?: string },
  body: (ctx: BackgroundRunCtx) => Promise<{ ok: boolean; summary?: string }>,
): { id: string; done: Promise<void> } {
  const controller = new AbortController();
  const id = registry.register({
    ...(opts.id ? { id: opts.id } : {}),
    model: opts.model,
    controller,
  });
  const done = acquire(opts.provider, async () => {
    try {
      const res = await body({
        id,
        append: (t) => registry.append(id, t),
        signal: controller.signal,
      });
      if (registry.get(id)?.state !== "killed") {
        registry.setState(id, res.ok ? "done" : "failed", res.summary);
      }
    } catch (e) {
      if (registry.get(id)?.state !== "killed") {
        registry.setState(id, "failed", e instanceof Error ? e.message : String(e));
      }
    }
  });
  return { id, done };
}
