/**
 * agent/compact.ts — autocompact + the session-event bus (file 14 §3.11).
 *
 * `/compact` summarize-and-replace to reclaim context window, auto-triggered near the
 * model's context limit; plus a published session lifecycle bus (created/idle/updated/
 * compacted) extensions hook (opencode's `session.compacting`). PURE trigger + bus; the
 * summarization is an injected model call (Tier policy from 12 applies — prefer the
 * small/local model). Fail-soft: a summarizer error keeps the transcript intact.
 */
import type { SessionTurn } from "./session-store.js";

/** Lifecycle events extensions can hook (§3.11 / §1.15). */
export type SessionEventKind = "created" | "idle" | "updated" | "compacting" | "compacted";

export interface SessionEvent {
  kind: SessionEventKind;
  sessionId: string;
  /** present on compacting/compacted. */
  detail?: { turnsBefore: number; turnsAfter: number; summary?: string };
}

/** A minimal typed event bus (no deps). */
export class SessionEventBus {
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  on(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: SessionEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}

/* ── compaction trigger (§3.11) ────────────────────────────────────────────── */

export interface CompactPolicy {
  /** compact when the estimated token count exceeds this. */
  maxTokens: number;
  /** keep this many most-recent turns verbatim (never summarized). */
  keepRecentTurns: number;
  /** rough chars-per-token for the estimate (default 4). */
  charsPerToken?: number;
}

/** Rough token estimate for a turn (prompt + assistant text). */
export function estimateTurnTokens(turn: SessionTurn, charsPerToken = 4): number {
  const text = turn.prompt + turn.events.map((e) => (e.kind === "text" ? e.text : "")).join("");
  return Math.ceil(text.length / charsPerToken);
}

/** Total estimated tokens across turns. */
export function estimateTokens(turns: readonly SessionTurn[], charsPerToken = 4): number {
  return turns.reduce((sum, t) => sum + estimateTurnTokens(t, charsPerToken), 0);
}

/** Whether the transcript should be compacted now (§3.11 auto-trigger). */
export function shouldCompact(turns: readonly SessionTurn[], policy: CompactPolicy): boolean {
  if (turns.length <= policy.keepRecentTurns) return false;
  return estimateTokens(turns, policy.charsPerToken) > policy.maxTokens;
}

/** Split turns into the older slice to summarize + the recent slice to keep verbatim. */
export function compactionSlices(
  turns: readonly SessionTurn[],
  policy: CompactPolicy,
): { older: SessionTurn[]; recent: SessionTurn[] } {
  const keep = Math.max(0, policy.keepRecentTurns);
  const cut = Math.max(0, turns.length - keep);
  return { older: turns.slice(0, cut), recent: turns.slice(cut) };
}

/** The injected summarizer — an ordinary model call over the older turns (§3.11). */
export type Summarizer = (older: readonly SessionTurn[]) => Promise<string>;

export interface CompactResult {
  turns: SessionTurn[];
  summary?: string;
  compacted: boolean;
  error?: string;
}

/**
 * Compact a transcript: summarize the older slice into a single synthetic turn + keep
 * the recent slice verbatim. Fail-soft — if the summarizer throws, return the ORIGINAL
 * turns + an error (never lose the transcript). Emits compacting/compacted on the bus.
 */
export async function compact(
  sessionId: string,
  turns: readonly SessionTurn[],
  policy: CompactPolicy,
  summarize: Summarizer,
  now: string,
  bus?: SessionEventBus,
): Promise<CompactResult> {
  const { older, recent } = compactionSlices(turns, policy);
  if (older.length === 0) return { turns: [...turns], compacted: false };
  bus?.emit({
    kind: "compacting",
    sessionId,
    detail: { turnsBefore: turns.length, turnsAfter: recent.length + 1 },
  });
  let summary: string;
  try {
    summary = await summarize(older);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { turns: [...turns], compacted: false, error };
  }
  const summaryTurn: SessionTurn = {
    id: `compact-${older.length}-${now}`,
    turnNumber: 0,
    prompt: "[compacted history]",
    events: [{ kind: "text", text: summary }],
    createdAt: now,
  };
  const merged = [summaryTurn, ...recent].map((t, i) => ({ ...t, turnNumber: i + 1 }));
  bus?.emit({
    kind: "compacted",
    sessionId,
    detail: { turnsBefore: turns.length, turnsAfter: merged.length, summary },
  });
  return { turns: merged, summary, compacted: true };
}
