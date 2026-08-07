/**
 * agent/session-store.ts — named, searchable, resumable conversation store (file 14 §3.10).
 *
 * GUI/CLI parity with `prometheus`'s /save//resume: a transcript store the agent pane + the
 * REPL share, each session pinned to a per-turn ChangeSet/checkpoint id so "revert this
 * message" reuses the 07 §7.4 atomic undo. PURE model + search + JSONL serialize;
 * persistence (writing `.prometheus/sessions/*.jsonl`) is the caller's. Secrets NEVER
 * enter a transcript (keychain stays in 09 §5.1).
 */
import type { AgentEvent } from "./events.js";

/** One turn's record (a user prompt + the agent's event stream for it). */
export interface SessionTurn {
  id: string;
  turnNumber: number;
  /** the user prompt that opened the turn (the assistant reply is in `events`). */
  prompt: string;
  events: AgentEvent[];
  /** the checkpoint id taken before this turn — revert restores to it (E2/§3.10). */
  checkpointId?: string;
  createdAt: string;
}

/** A whole conversation (the unit /save//resume + the GUI session list operate on). */
export interface Session {
  id: string;
  title: string;
  /** the workspace path the session belongs to (search facet). */
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
  turns: SessionTurn[];
}

/** Create an empty session. */
export function createSession(
  id: string,
  title: string,
  now: string,
  workspacePath?: string,
): Session {
  return {
    id,
    title,
    ...(workspacePath ? { workspacePath } : {}),
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
}

/** Append a turn (returns a NEW session; turnNumber auto-assigned). */
export function appendTurn(session: Session, turn: Omit<SessionTurn, "turnNumber">): Session {
  const turnNumber = session.turns.length + 1;
  return {
    ...session,
    updatedAt: turn.createdAt,
    turns: [...session.turns, { ...turn, turnNumber }],
  };
}

/** Rename a session (returns a NEW session). */
export function renameSession(session: Session, title: string, now: string): Session {
  return { ...session, title, updatedAt: now };
}

/** The checkpoint id to revert to for a given turn (E2/§3.10). */
export function revertTargetFor(session: Session, turnNumber: number): string | undefined {
  return session.turns.find((t) => t.turnNumber === turnNumber)?.checkpointId;
}

/** Drop every turn AFTER `turnNumber` (revert truncates the forward history). */
export function truncateAfter(session: Session, turnNumber: number, now: string): Session {
  return {
    ...session,
    updatedAt: now,
    turns: session.turns.filter((t) => t.turnNumber <= turnNumber),
  };
}

/* ── search (§3.10 — by title / date / path / content) ─────────────────────── */

export interface SessionQuery {
  /** substring over title (+ optionally content). */
  text?: string;
  workspacePath?: string;
  /** ISO lower bound on updatedAt. */
  since?: string;
  /** also scan turn prompts + assistant text for `text`. */
  includeContent?: boolean;
}

function turnText(turn: SessionTurn): string {
  const reply = turn.events.map((e) => (e.kind === "text" ? e.text : "")).join(" ");
  return `${turn.prompt} ${reply}`;
}

/** Filter + sort sessions (most recently updated first) by a query (§3.10). */
export function searchSessions(sessions: readonly Session[], query: SessionQuery): Session[] {
  const text = query.text?.trim().toLowerCase();
  return [...sessions]
    .filter((s) => {
      if (query.workspacePath && s.workspacePath !== query.workspacePath) return false;
      if (query.since && s.updatedAt < query.since) return false;
      if (text) {
        const inTitle = s.title.toLowerCase().includes(text);
        const inContent =
          query.includeContent && s.turns.some((t) => turnText(t).toLowerCase().includes(text));
        if (!inTitle && !inContent) return false;
      }
      return true;
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/* ── serialize (JSONL — one line per turn, a header line per session) ──────── */

/** Serialize a session to JSONL (header line + one line per turn). */
export function serializeSession(session: Session): string {
  const header = JSON.stringify({
    _t: "session",
    id: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
  const turns = session.turns.map((t) => JSON.stringify({ _t: "turn", ...t }));
  return [header, ...turns].join("\n");
}

/** Parse a JSONL session (fail-soft → null on a malformed header). */
export function deserializeSession(jsonl: string): Session | null {
  const lines = jsonl.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  let header: {
    id?: string;
    title?: string;
    workspacePath?: string;
    createdAt?: string;
    updatedAt?: string;
  } = {};
  try {
    header = JSON.parse(lines[0] as string);
  } catch {
    return null;
  }
  if (typeof header.id !== "string" || typeof header.title !== "string") return null;
  const turns: SessionTurn[] = [];
  for (const line of lines.slice(1)) {
    try {
      const t = JSON.parse(line) as SessionTurn & { _t?: string };
      if (typeof t.id === "string" && typeof t.turnNumber === "number") {
        const { _t, ...rest } = t;
        turns.push(rest as SessionTurn);
      }
    } catch {
      // skip a corrupt turn line; never crash the whole session (fail-soft)
    }
  }
  return {
    id: header.id,
    title: header.title,
    ...(header.workspacePath ? { workspacePath: header.workspacePath } : {}),
    createdAt: header.createdAt ?? "",
    updatedAt: header.updatedAt ?? "",
    turns,
  };
}
