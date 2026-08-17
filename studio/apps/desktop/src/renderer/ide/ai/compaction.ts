/**
 * ai/compaction.ts — keep a long GUI conversation inside the model's window.
 *
 * Both CLI hosts have compacted since the feature was written; the pane never has, so a long
 * session simply grew until the model started refusing or truncating, with no warning and no
 * recovery. That was a gap; raising the round cap from 8 to 32 turned it into debt, because a
 * single turn can now do four times as much work before it ends.
 *
 * WHY THIS IS NOT A PORT OF THE CLI'S VERSION. `compactSession`/`autoCompactPolicy` live in
 * apps/cli and are typed to that host's `SessionTurn` (`{prompt, events}`), while the pane's
 * transcript is `{role, content}`; they are also node-tainted, and the renderer is sandboxed.
 * Rather than teach either host the other's type, the decision is taken over plain TEXT via
 * core's `shouldCompactTexts`/`sliceForCompaction` — the split was always by COUNT and the
 * estimate only ever needed characters.
 *
 * FAIL-SOFT IS THE CONTRACT. A summarizer that errors, times out, or returns nothing leaves the
 * transcript EXACTLY as it was. Losing the conversation to a failed attempt at saving it is a
 * far worse outcome than letting it run long, and the next turn will simply try again.
 *
 * PURE over its injected summarizer: no fetch, no store access, no React.
 */
import { shouldCompactTexts, sliceForCompaction } from "@prometheus/core/agent-compact";

import type { AiTurn } from "../state/stores.js";

/** Keep this many most-recent turns verbatim. Matches the CLI's `COMPACT_KEEP_RECENT`. */
export const KEEP_RECENT_TURNS = 4;

/** Compact once the transcript passes this share of the window. Matches the CLI's 85%. */
export const COMPACT_THRESHOLD_PCT = 85;

/** The marker that tells a reader — and the model — that history was folded up. */
export const COMPACTED_PREFIX = "[earlier conversation, summarized]";

/**
 * The token budget a transcript may occupy before compaction, or null when it is unknowable.
 *
 * Null is a load-bearing sentinel rather than a zero: "no window information" must DISABLE the
 * check, not trigger it on every turn. The CLI's `autoCompactPolicy` returns null the same way
 * and for the same reason.
 */
export function compactionBudget(contextWindow: number | undefined): number | null {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return Math.floor((contextWindow * COMPACT_THRESHOLD_PCT) / 100);
}

/** Whether this transcript should be compacted before the next turn. */
export function needsCompaction(
  turns: readonly AiTurn[],
  contextWindow: number | undefined,
): boolean {
  const maxTokens = compactionBudget(contextWindow);
  if (maxTokens === null) return false;
  return shouldCompactTexts(
    turns.map((t) => t.content),
    { maxTokens, keepRecentTurns: KEEP_RECENT_TURNS },
  );
}

/** A deterministic fallback when no model can summarize: the first line of each older turn. */
export function extractiveSummary(older: readonly AiTurn[], maxChars = 2000): string {
  const lines = older.map((t) => {
    const first = t.content.split("\n").find((l) => l.trim()) ?? "";
    return `${t.role}: ${first.slice(0, 160)}`;
  });
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export interface CompactResult {
  turns: AiTurn[];
  /** true when the transcript actually changed — the caller only writes the store then. */
  compacted: boolean;
  /** a one-line note for the transcript, when something happened. */
  note?: string;
}

/**
 * Fold the older part of a transcript into one summary turn.
 *
 * Returns the transcript UNCHANGED when there is nothing to do or when summarizing failed. The
 * summary is stored as an `assistant` turn because the pane's shape has no third role, and it is
 * prefixed so that neither a human reading back nor the model mistakes a summary for something
 * that was actually said.
 */
export async function compactTurns(
  turns: readonly AiTurn[],
  contextWindow: number | undefined,
  summarize: (older: readonly AiTurn[]) => Promise<string>,
): Promise<CompactResult> {
  if (!needsCompaction(turns, contextWindow)) return { turns: [...turns], compacted: false };
  const { older, recent } = sliceForCompaction(turns, {
    maxTokens: compactionBudget(contextWindow) ?? 0,
    keepRecentTurns: KEEP_RECENT_TURNS,
  });
  if (older.length === 0) return { turns: [...turns], compacted: false };

  let summary = "";
  try {
    summary = (await summarize(older)).trim();
  } catch {
    summary = ""; // fall through to the extractive fallback
  }
  if (!summary) summary = extractiveSummary(older);
  // Even the fallback can come back empty (a transcript of blank turns). Leaving the history
  // alone beats replacing it with a summary that says nothing.
  if (!summary.trim()) return { turns: [...turns], compacted: false };

  return {
    turns: [{ role: "assistant", content: `${COMPACTED_PREFIX}\n${summary}` }, ...recent],
    compacted: true,
    note: `compacted ${older.length} earlier turn(s) to fit the model's context`,
  };
}
