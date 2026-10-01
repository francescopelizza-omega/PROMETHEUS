// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/carry-forward.ts — what the agent REMEMBERS from one turn to the next.
 *
 * Both CLI hosts rebuilt the cross-turn thread like this:
 *
 *     history = [...history, { role: "user", content: input }, { role: "assistant", content: reply }]
 *
 * and threw away `res.thread` — the post-turn thread the loop had just folded every tool call and
 * every tool result into. So the model began each turn having read nothing. It could spend six
 * rounds reading a file, answer a question about it, and then be unable to answer a follow-up
 * without reading the file again, because the only trace of its work was its own prose summary.
 * `turnsToHistory` (the post-compaction rebuild) dropped them the same way, so the two paths agreed
 * — and were both wrong in the same direction, which is why neither looked suspicious.
 *
 * That is the difference between a chat client and an agent. An agent's context IS its work.
 *
 * WHY THIS IS NOT JUST `history = res.thread`. Tool output is the largest thing in a session by an
 * order of magnitude — a single `read_file` on a 2000-line source file is more tokens than a whole
 * conversation of prose. Carrying it forward verbatim and unbounded would overflow the window in
 * three turns, which is a worse failure than forgetting: it fails mid-task, after the user has
 * committed, rather than at the start.
 *
 * So the policy is to keep the STRUCTURE always and the BULK selectively:
 *
 *   1. Every user and assistant message is kept verbatim. They are the spine of the conversation
 *      and are small; dropping one loses the thread of what was asked.
 *   2. Recent tool results are kept whole, up to `perResultTokens`.
 *   3. Older tool results are ELIDED to a head and a tail with a marker naming what was cut. A
 *      marker matters: the model must be able to tell "I read this and the middle is gone" from
 *      "I never read this", because those call for different next actions.
 *   4. If it still does not fit, whole ROUNDS are dropped from the oldest end — never a partial
 *      round. An assistant message carrying `toolCalls` and the `tool` messages answering them are
 *      one unit: a provider that receives a `tool_result` for a call it cannot see rejects the
 *      request outright, so a naive oldest-first trim produces a 400 rather than a smaller prompt.
 *   5. The final user message is never dropped. If the budget cannot fit even that, the caller has
 *      a context-window problem that compaction — not this — has to solve.
 *
 * PURE: no IO, no clock, no state.
 */
import { estimateTextTokens } from "./compact.js";
import type { ThreadMessage } from "./loop.js";

export interface CarryForwardOptions {
  /**
   * Total token budget for the carried thread.
   *
   * Callers derive it from the model's context window rather than hard-coding one: the same
   * session is worth 8k tokens of memory on a small local model and 200k on Claude, and a fixed
   * number is wrong in one direction or the other on every endpoint.
   */
  budgetTokens: number;
  /** Cap on ONE retained tool result before it is elided. Defaults to a tenth of the budget. */
  perResultTokens?: number;
  /** chars per token for the estimate; matches `compact.ts`. */
  charsPerToken?: number;
}

/** The marker left where tool output was cut. Recognisable, and honest about what happened. */
export const ELISION = (cutTokens: number): string =>
  `\n\n… [${cutTokens} tokens of this tool result elided to fit the context window; re-run the tool if you need the middle] …\n\n`;

/**
 * The marker left at the front of the oldest SURVIVING round when whole earlier rounds were
 * dropped (pass 2, below). Unlike `ELISION` — which annotates the exact tool result it cut —
 * a dropped round leaves no content behind to attach a marker to, so without this the model
 * sees history simply start abruptly, with nothing telling it (as opposed to the human, who
 * sees the terminal's own "context trimmed to fit" notice) that anything is missing. A model
 * that cannot tell "this was never here" from "this was removed" is liable to keep confidently
 * re-deriving or re-asserting things it already settled several rounds ago.
 */
export const ROUND_DROP = (roundCount: number): string =>
  `[… ${roundCount} earlier round${roundCount === 1 ? "" : "s"} of this conversation were dropped to fit the context window — anything asked, decided, or written to disk in them is no longer visible here. If this turn seems to reference something from before this point, say so and ask, or re-read the relevant file, rather than guessing or re-doing it from scratch …]\n\n`;

/** A message plus the messages that cannot be separated from it. */
interface Round {
  messages: ThreadMessage[];
  tokens: number;
}

const tokensOf = (m: ThreadMessage, charsPerToken: number): number =>
  estimateTextTokens([m.content], charsPerToken);

/**
 * Group a flat thread into indivisible rounds.
 *
 * A round is one user message and everything that followed it up to the next user message —
 * assistant prose, the calls it made, and the results of those calls. Grouping is what makes the
 * trim safe: `tool` messages reference calls announced on an `assistant` message, and separating
 * the two is a provider error rather than a smaller prompt.
 */
function toRounds(thread: readonly ThreadMessage[]): Round[] {
  const rounds: Round[] = [];
  for (const m of thread) {
    if (m.role === "user" || rounds.length === 0) {
      rounds.push({ messages: [m], tokens: 0 });
      continue;
    }
    (rounds[rounds.length - 1] as Round).messages.push(m);
  }
  return rounds;
}

/** Elide the middle of an over-long tool result, keeping a head and a tail. */
function elide(content: string, maxTokens: number, charsPerToken: number): string {
  const maxChars = maxTokens * charsPerToken;
  if (content.length <= maxChars) return content;
  // Two thirds head, one third tail: the head carries the shape of the output (a file's imports,
  // a command's first errors) and the tail carries the conclusion (the exit line, the summary).
  const head = Math.floor((maxChars * 2) / 3);
  const tail = maxChars - head;
  const cut = Math.ceil((content.length - maxChars) / charsPerToken);
  return content.slice(0, head) + ELISION(cut) + content.slice(content.length - tail);
}

/**
 * The thread to carry into the next turn.
 *
 * Takes the post-turn thread (`MessageTurnResult.thread`) — which already contains the folded
 * tool calls and results — and returns a budgeted version of it.
 */
export function carryForward(
  thread: readonly ThreadMessage[],
  opts: CarryForwardOptions,
): ThreadMessage[] {
  const charsPerToken = opts.charsPerToken ?? 4;
  const budget = Math.max(0, Math.floor(opts.budgetTokens));
  const perResult = Math.max(64, Math.floor(opts.perResultTokens ?? budget / 10));
  // System messages are re-assembled fresh every turn (prompt, steering, repo map), so carrying
  // one forward would duplicate it — and duplicate it again the turn after that.
  const body = thread.filter((m) => m.role !== "system");
  if (body.length === 0) return [];

  const rounds = toRounds(body);
  const lastIndex = rounds.length - 1;

  // Pass 1 — cap tool results, most recent round exempt. The round the model just finished is the
  // one it is most likely to be asked about next, so it keeps its output whole.
  const capped = rounds.map((r, i) => {
    const messages =
      i === lastIndex
        ? r.messages
        : r.messages.map((m) =>
            m.role === "tool" ? { ...m, content: elide(m.content, perResult, charsPerToken) } : m,
          );
    return {
      messages,
      tokens: messages.reduce((n, m) => n + tokensOf(m, charsPerToken), 0),
    };
  });

  // Pass 2 — drop whole rounds from the OLDEST end until it fits.
  let total = capped.reduce((n, r) => n + r.tokens, 0);
  let first = 0;
  while (total > budget && first < lastIndex) {
    total -= (capped[first] as Round).tokens;
    first += 1;
  }
  const kept = capped.slice(first);

  // A dropped round leaves no trace unless we leave one: prepend the marker to the oldest
  // surviving round's own opening user message (guaranteed to exist and be `role:"user"` — see
  // `toRounds`) rather than inserting a synthetic message of our own. That keeps the message
  // list's role sequence exactly as the caller already expects (one user message opens a round),
  // instead of introducing an extra system-role entry mid-thread that some wire formats may not
  // expect outside position zero.
  if (first > 0 && kept.length > 0) {
    const round = kept[0] as Round;
    const opening = round.messages[0];
    if (opening) {
      kept[0] = {
        ...round,
        messages: [
          { ...opening, content: ROUND_DROP(first) + opening.content },
          ...round.messages.slice(1),
        ],
      };
    }
  }

  // Pass 3 — the last round alone can still exceed the budget (one enormous tool result). Elide
  // its tool output too rather than returning something that cannot be sent. The user message and
  // the assistant prose are never touched: losing the question to fit the answer's output is not a
  // trade worth making.
  if (total > budget && kept.length > 0) {
    const last = kept[kept.length - 1] as Round;
    const fixed = last.messages.reduce(
      (n, m) => (m.role === "tool" ? n : n + tokensOf(m, charsPerToken)),
      0,
    );
    const room = Math.max(64, budget - fixed);
    const toolCount = last.messages.filter((m) => m.role === "tool").length || 1;
    const each = Math.max(64, Math.floor(room / toolCount));
    last.messages = last.messages.map((m) =>
      m.role === "tool" ? { ...m, content: elide(m.content, each, charsPerToken) } : m,
    );
  }

  return kept.flatMap((r) => r.messages);
}

/**
 * The carry budget for a model with this context window.
 *
 * A fraction, not the whole thing: the window also has to hold the system prompt, the steering
 * block, the repo map, the tool schemas, this turn's new work and the model's reply. Half is the
 * largest share that reliably leaves room for a multi-round turn on top of it.
 */
export function carryBudgetFor(contextWindow: number | undefined): number {
  const w = contextWindow && contextWindow > 0 ? contextWindow : 8192;
  return Math.max(1024, Math.floor(w / 2));
}
