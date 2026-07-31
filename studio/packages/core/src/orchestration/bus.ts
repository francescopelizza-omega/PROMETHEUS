/**
 * orchestration/bus.ts — the inter-agent MESSAGE BUS (the comms fabric).
 *
 * Every agent in the `/demos` tree talks through ONE append-only message log. An agent
 * addresses a peer (sibling/parent/child) by name, or "broadcast"; the bus delivers via
 * per-address read cursors (actor-mailbox model). The log is the single source of truth:
 * it serializes to JSONL under ~/.prometheus/orchestration/<run>/bus.jsonl for full
 * transparency + replay, and a subscribe() seam streams it live to the TUI. This is how
 * the orchestrator ↔ subagents ↔ child-subagents communicate — directly + auditable.
 *
 * PURE-ish: the clock + id source are injected so a run is deterministic in tests.
 */

/** The kind of a message (drives routing + the live-view rendering). */
export type MessageKind =
  | "task" // a dispatched subtask (orchestrator→subagent, or peer→peer)
  | "result" // a completed task's output
  | "msg" // a free peer-to-peer note
  | "question" // a clarifying question (expects an answer)
  | "answer" // the reply to a question
  | "spawn" // a child-subagent was created
  | "error" // a failure
  | "log"; // a transparency/trace line

/** One message on the bus. `to` is an agent name, "broadcast", or the orchestrator. */
export interface Message {
  id: string;
  from: string;
  to: string;
  kind: MessageKind;
  content: string;
  /** correlates a `result`/`answer` back to the `task`/`question` it satisfies. */
  taskId?: string;
  /** the id of the message this one replies to. */
  parentId?: string;
  ts: number;
}

/** A message to post (id + ts are filled by the bus unless provided). */
export type PostInput = Omit<Message, "id" | "ts"> & Partial<Pick<Message, "id" | "ts">>;

export interface BusDeps {
  now?: () => number;
  genId?: () => string;
}

const BROADCAST = "broadcast";

/** Is message `m` deliverable to `address` (addressed to it or broadcast, not its own)? */
function deliverable(m: Message, address: string): boolean {
  return (m.to === address || m.to === BROADCAST) && m.from !== address;
}

export class MessageBus {
  private readonly log: Message[] = [];
  private readonly cursors = new Map<string, number>();
  private readonly subs = new Set<(m: Message) => void>();
  private readonly now: () => number;
  private readonly genId: () => string;
  private seq = 0;

  constructor(deps: BusDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.genId = deps.genId ?? (() => `m${(this.seq++).toString(36)}`);
  }

  /** Append a message; fills id + ts; notifies subscribers; returns the stored message. */
  post(input: PostInput): Message {
    const m: Message = {
      id: input.id ?? this.genId(),
      ts: input.ts ?? this.now(),
      from: input.from,
      to: input.to,
      kind: input.kind,
      content: input.content,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.parentId ? { parentId: input.parentId } : {}),
    };
    this.log.push(m);
    for (const s of this.subs) {
      try {
        s(m);
      } catch {
        /* a bad subscriber must never break the bus */
      }
    }
    return m;
  }

  /** The whole log (read-only). */
  all(): readonly Message[] {
    return this.log;
  }

  /** Every message ever visible to `address` (no cursor advance). */
  visibleTo(address: string): Message[] {
    return this.log.filter((m) => deliverable(m, address));
  }

  /** The UNREAD messages for `address` since its last drain; advances its cursor. */
  drainFor(address: string): Message[] {
    const start = this.cursors.get(address) ?? 0;
    const out: Message[] = [];
    for (let i = start; i < this.log.length; i++) {
      const m = this.log[i] as Message;
      if (deliverable(m, address)) out.push(m);
    }
    this.cursors.set(address, this.log.length);
    return out;
  }

  /** Find the messages correlated to a task id (its result/answers). */
  forTask(taskId: string): Message[] {
    return this.log.filter((m) => m.taskId === taskId);
  }

  /** Subscribe to every posted message (the live TUI view). Returns an unsubscribe fn. */
  subscribe(fn: (m: Message) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  /** Serialize the log to JSONL (one message per line). */
  serialize(): string {
    return this.log.map((m) => JSON.stringify(m)).join("\n");
  }

  /** Rebuild a bus from JSONL (replay/inspection). Cursors start fresh; bad lines skipped. */
  static deserialize(jsonl: string, deps: BusDeps = {}): MessageBus {
    const bus = new MessageBus(deps);
    for (const line of jsonl.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        bus.log.push(JSON.parse(t) as Message);
      } catch {
        /* skip a corrupt line rather than abort the whole replay */
      }
    }
    return bus;
  }
}

const MESSAGE_KINDS = new Set<MessageKind>([
  "task",
  "result",
  "msg",
  "question",
  "answer",
  "spawn",
  "error",
  "log",
]);

/** A parsed value is a well-formed bus Message (the fields routing + the renderers rely on). */
function isMessage(v: unknown): v is Message {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.from === "string" &&
    typeof m.to === "string" &&
    typeof m.kind === "string" &&
    MESSAGE_KINDS.has(m.kind as MessageKind) &&
    typeof m.content === "string" &&
    typeof m.ts === "number"
  );
}

/**
 * STRICT JSONL → Message[] for REPLAY (CLI-073). Unlike `MessageBus.deserialize`, which silently
 * skips bad lines (fine for lenient inspection), this FAILS CLOSED: a non-empty line that is not
 * valid JSON — or that parses but is not a well-formed Message — throws, naming the 1-based line
 * number + a short prefix. So a run that crashed mid-write (its last line a partial object) is
 * never presented as a COMPLETE replay. Empty segments (incl. the trailing-newline's empty final
 * segment) are skipped as OK; only a NON-empty unparseable line is the truncation signal.
 */
export function parseBusJsonl(jsonl: string): Message[] {
  const out: Message[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] as string).trim();
    if (!t) continue; // empty line / trailing newline — not a truncation
    const prefix = t.length > 40 ? `${t.slice(0, 40)}…` : t;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      throw new Error(`corrupt run log at line ${i + 1}: not valid JSON — "${prefix}"`);
    }
    if (!isMessage(parsed)) {
      throw new Error(`corrupt run log at line ${i + 1}: not a bus message — "${prefix}"`);
    }
    out.push(parsed);
  }
  return out;
}
