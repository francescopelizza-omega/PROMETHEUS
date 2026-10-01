// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
  /**
   * TOOL OUTPUT COUNTS. It used to weigh exactly zero.
   *
   * The estimate summed `turn.prompt` and the `text` events — the model's prose — and ignored
   * every `tool_result`. But tool output is the largest thing in an agentic session by an
   * order of magnitude: one `read_file` on a 2000-line source file is more characters than a
   * whole conversation of prose. So a session that had read ten files registered as nearly
   * empty, `shouldCompact` stayed false, and the transcript sailed past the context window
   * without ever compacting — until the provider rejected it mid-task.
   *
   * That is the exact inverse of what the trigger is for: it was blind precisely where the
   * agent does its work, and accurate only in the chat-like case that was never going to
   * overflow. `tool_use` arguments are counted too — an `apply_patch` payload is real input.
   */
  const parts: string[] = [turn.prompt];
  for (const e of turn.events) {
    if (e.kind === "text") parts.push(e.text);
    else if (e.kind === "reasoning") parts.push(e.text);
    else if (e.kind === "tool_result") parts.push(e.summary);
    else if (e.kind === "tool_use") parts.push(JSON.stringify(e.call.args ?? {}));
  }
  return Math.ceil(parts.join("").length / charsPerToken);
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

/* ── the shape-agnostic core (§3.11, shared by hosts with different turn types) ──────────── *
 *
 * The three functions above are typed to `SessionTurn` — the CLI's shape, `{prompt, events}`.
 * The desktop's transcript is `{role, content}` and cannot satisfy it, which is why the GUI has
 * had no compaction at all while both CLI hosts have had it since it was written.
 *
 * Rather than teach one host the other's type or fork the arithmetic, the decision is expressed
 * over plain TEXT. Both shapes can render themselves as text; nothing else about a turn matters
 * to a token estimate.
 * ─────────────────────────────────────────────────────────────────────────────────────────── */

/** Rough token estimate for a list of already-rendered turn texts. */
export function estimateTextTokens(texts: readonly string[], charsPerToken = 4): number {
  return texts.reduce((sum, t) => sum + Math.ceil(t.length / charsPerToken), 0);
}

/** Whether a transcript of these turn texts should be compacted now. */
export function shouldCompactTexts(texts: readonly string[], policy: CompactPolicy): boolean {
  if (texts.length <= policy.keepRecentTurns) return false;
  return estimateTextTokens(texts, policy.charsPerToken) > policy.maxTokens;
}

/**
 * Split ANY turn list into the older slice to summarize + the recent slice to keep verbatim.
 *
 * Identical arithmetic to `compactionSlices`, without the `SessionTurn` constraint — the split
 * is by COUNT, so it never needed the shape in the first place.
 */
export function sliceForCompaction<T>(
  turns: readonly T[],
  policy: CompactPolicy,
): { older: T[]; recent: T[] } {
  const keep = Math.max(0, policy.keepRecentTurns);
  const cut = Math.max(0, turns.length - keep);
  return { older: turns.slice(0, cut), recent: turns.slice(cut) };
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
