/**
 * orchestration/demos-status-board.ts — the LIVE participant board reducer (CLI-074).
 *
 * A PURE state machine that folds a swarm's activity — bus messages (headless backend) OR tmux
 * pane-liveness snapshots (tmux backend) — into a per-agent board `{state, lastActivityAt,
 * lastMessage?}`. Two transports feed the SAME reducer (a headless run has bus events; a tmux run
 * polls `tmux-driver` liveness), so it is unit-tested without any live subprocess. `LiveBoard`
 * wraps it as the first real consumer of `MessageBus.subscribe()`. The `dead` state is shaped so
 * CLI-075 (crash/restart) can react to it; this file never restarts anything (read-only view).
 */
import type { orchestration } from "@prometheus/core";

type Message = orchestration.Message;

/** A single agent's live state. `dead` is terminal (its pane/process exited). */
export type AgentBoardState = "idle" | "busy" | "dead";

export interface BoardEntry {
  state: AgentBoardState;
  /** a monotonic activity marker (injected clock / tick) — NOT wall-clock, so tests stay stable. */
  lastActivityAt: number;
  /** the last message content that touched this agent (clipped), for the board's trailing note. */
  lastMessage?: string;
}

export type Board = Record<string, BoardEntry>;

/** The two input variants the reducer accepts (gotcha: headless=bus, tmux=liveness). */
export type BoardInput =
  | { kind: "bus"; msg: Message }
  | { kind: "liveness"; live: readonly string[]; roster: readonly string[] };

/** The minimal bus surface `LiveBoard` needs (structural — avoids depending on the class type). */
interface BusLike {
  subscribe(fn: (m: Message) => void): () => void;
}

const clip = (s: string, n = 48): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};

/** A fresh board: every agent idle, no activity yet. */
export function initBoard(ids: readonly string[]): Board {
  const board: Board = {};
  for (const id of ids) board[id] = { state: "idle", lastActivityAt: 0 };
  return board;
}

/** A `result`/`answer` means the sender just DELIVERED (→ free/idle); anything else = working. */
function stateFromKind(kind: Message["kind"]): AgentBoardState {
  return kind === "result" || kind === "answer" ? "idle" : "busy";
}

/**
 * Fold one input into the board (PURE — returns a new board, never mutates `now` is the injected
 * activity clock). A bus message marks its SENDER busy/idle (result/answer ⇒ idle) and its
 * addressed RECIPIENT busy (it has incoming work); broadcast/self recipients are ignored. A
 * liveness snapshot marks any roster agent NOT in `live` as `dead` (terminal) — this catches both
 * `#{pane_dead}` and a pane that vanished from `list-panes` entirely.
 */
export function reduceBoard(board: Board, input: BoardInput, now: number): Board {
  const next: Board = { ...board };
  const touch = (id: string, patch: Partial<BoardEntry>): void => {
    const prev = next[id] ?? { state: "idle" as AgentBoardState, lastActivityAt: 0 };
    next[id] = { ...prev, ...patch, lastActivityAt: now };
  };

  if (input.kind === "bus") {
    const m = input.msg;
    // a dead agent is terminal — a stray late message never resurrects it.
    if (next[m.from]?.state !== "dead") {
      touch(m.from, { state: stateFromKind(m.kind), lastMessage: clip(m.content) });
    }
    if (m.to && m.to !== "broadcast" && m.to !== m.from && next[m.to]?.state !== "dead") {
      touch(m.to, { state: "busy" });
    }
    return next;
  }

  // liveness: only DOWNGRADES to dead (never resurrects) — pane-dead is terminal.
  const live = new Set(input.live);
  for (const id of input.roster) {
    if (!live.has(id)) touch(id, { state: "dead" });
    else if (!next[id]) touch(id, { state: "idle" }); // first sighting of a live agent
  }
  return next;
}

/**
 * The live board wrapper — the FIRST real caller of `MessageBus.subscribe()` (CLI-074; it had zero
 * non-test callers). `attach(bus)` subscribes and folds every posted message into the board; the
 * returned dispose unsubscribes (call it on run/watch exit or the subscription leaks). `now`
 * defaults to a monotonic per-update tick (deterministic); production may inject `Date.now`.
 */
export class LiveBoard {
  private board: Board;
  private readonly ids: string[];
  private readonly now: () => number;
  private ticks = 0;
  private dispose: (() => void) | null = null;

  constructor(ids: readonly string[], now?: () => number) {
    this.ids = [...ids];
    this.now = now ?? (() => this.ticks);
    this.board = initBoard(this.ids);
  }

  /** Subscribe to the bus (idempotent — guards a double-attach on re-entering watch). */
  attach(bus: BusLike): () => void {
    if (this.dispose) return this.dispose;
    const unsub = bus.subscribe((m) => {
      this.ticks++;
      this.board = reduceBoard(this.board, { kind: "bus", msg: m }, this.now());
    });
    this.dispose = () => {
      unsub();
      this.dispose = null;
    };
    return this.dispose;
  }

  /** Fold a tmux liveness snapshot (polled, not pushed). `roster` defaults to the known agents. */
  applyLiveness(live: readonly string[], roster: readonly string[] = this.ids): void {
    this.ticks++;
    this.board = reduceBoard(this.board, { kind: "liveness", live, roster }, this.now());
  }

  /** The current board (a live reference — callers should render, not mutate). */
  snapshot(): Board {
    return this.board;
  }

  /** The agent render order (topology order). */
  order(): string[] {
    return [...this.ids];
  }
}
