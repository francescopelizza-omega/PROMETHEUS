/**
 * continuation.ts — "the model said it was about to work, then called nothing".
 *
 * The agent loop ends a turn when a round produces no tool call, because that is the only
 * signal a model gives for "I am answering rather than working". For a model with good tool
 * discipline that is exactly right. For a weaker one — local models especially — it is a cliff:
 *
 *     round 1  mkdir BULBMLEBEE                       ✓ ran
 *     round 2  "I'll create the folder and build out all 10 scripts. Let me get started."
 *              …no tool call. Turn over, at round 2 of 48.
 *
 * Nothing failed and nothing was reported: the user asked for ten files, got one directory, and
 * a turn that looked like it had finished. Re-prompting by hand ("you did not create anything")
 * made the same model carry straight on — so the model was willing, it had simply narrated its
 * plan instead of acting and the loop took the narration for an answer.
 *
 * This module decides, from the model's own final words, whether that is what just happened.
 *
 * ## Why the TAIL, and why a verb
 *
 * Announcing work mid-message is normal and says nothing ("I'll create ten scripts. Here they
 * are: …"). Announcing it as the LAST thing said, with nothing after it, is the shape of a model
 * that stopped mid-intent. So only the tail is considered, and only with an action verb attached
 * — which is also what keeps the commonest sign-off in the language, "let me know if you need
 * anything else", from reading as unfinished work.
 *
 * The predicate is deliberately conservative. A missed nudge costs one manual "continue"; a false
 * one puts words in the model's mouth after it has genuinely finished, and does it invisibly.
 */

/** How much of the end of the message counts as "the last thing said". */
const TAIL_CHARS = 220;

/**
 * Verbs that describe DOING the task.
 *
 * Narration verbs (`summarize`, `explain`, `recap`) are deliberately absent: a model that ends on
 * "let me explain:" has usually just explained, and nudging it would argue with a finished answer.
 */
const ACTION_VERBS = new Set([
  "add",
  "begin",
  "build",
  "code",
  "compose",
  "continue",
  "create",
  "define",
  "do",
  "draft",
  "generate",
  "get", // "let me get started"
  "implement",
  "install",
  "make",
  "proceed",
  "produce",
  "put",
  "run",
  "set",
  "start",
  "write",
]);

/**
 * First-person intent, immediately followed by the verb it governs.
 *
 * `(?!know\b)` is load-bearing: "let me know if …" is a sign-off, not a plan, and it is how most
 * finished answers end. The verb is captured rather than matched loosely so the decision rests on
 * the whole word — "write" is action, "written" ("I've written them") is a report of work done.
 *
 * An adverb may sit between the intent and the verb ("I will NOW create the files"), so a bounded
 * run of them is skipped; without that, the commonest phrasing of all slipped through as finished.
 */
const INTENT =
  /\b(?:let me|let['’]s|i will|i'?ll|i am going to|i'?m going to)\s+(?!know\b)(?:(?:now|then|also|first|next|just|quickly|immediately|go ahead and)\s+)*([a-z]+)/gi;

/** Past-tense/completion language anywhere in the tail: the model is reporting, not promising. */
const COMPLETED =
  /\b(?:created|wrote|written|added|built|generated|implemented|installed|finished|completed|done|all set|here (?:they|it) (?:are|is))\b/i;

/**
 * Did the model announce imminent work as its final word, without doing any?
 *
 * Call ONLY for a round that produced no tool call — this asks "was that an answer or an
 * intention?", which is meaningless for a round that acted.
 */
export function announcesUnfinishedWork(assistantText: string): boolean {
  const text = assistantText.trim();
  if (!text) return false;
  const tail = text.slice(-TAIL_CHARS);
  // A completion report wins outright: "I created all ten. Let me get you a summary" is finished
  // work, whatever it promises next.
  if (COMPLETED.test(tail)) return false;
  INTENT.lastIndex = 0;
  for (const m of tail.matchAll(INTENT)) {
    const verb = (m[1] ?? "").toLowerCase();
    if (ACTION_VERBS.has(verb)) return true;
  }
  return false;
}

/**
 * What the model is told when it announced work and called nothing.
 *
 * Phrased so BOTH answers are legitimate — the model that still has work does it, and the model
 * that has genuinely finished says so and the turn ends on the next round. A nudge that only
 * permitted "keep going" would talk a finished model into inventing more work.
 */
export const CONTINUATION_NUDGE =
  "You described what you were about to do but did not call any tool, so nothing happened. " +
  "If work remains, make the tool call now — do not restate the plan. " +
  "If the task is already complete, say so plainly and stop.";

/** How many times one turn may be nudged before the loop takes the silence as an answer. */
export const DEFAULT_MAX_NUDGES = 2;
