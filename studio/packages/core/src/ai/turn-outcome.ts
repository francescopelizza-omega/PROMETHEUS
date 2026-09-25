/**
 * ai/turn-outcome.ts — what to SAY when a turn produced no usable answer.
 *
 * A turn can end with nothing to show and still be a perfectly successful HTTP call: the model
 * was cut off at the context limit, or it spent the whole reply on reasoning, or it simply
 * returned an empty message. Every one of those used to end in silence — the pane printed the
 * elapsed-time line and moved on, the transcript recorded only `{"kind":"done"}`, and the user
 * was left to conclude the model had "stopped answering".
 *
 * Measured 2026-09-24 with a local thinking model: the prompt was 7,254 tokens of an 8,192-token
 * serving window (ollama: `n_tokens = 8191, truncated = 1`), so the answer — including the
 * `write_file` call the model had just decided on — never fit. Nothing was shown at all.
 *
 * One wording, shared by every surface, and every notice names a next step: a message that only
 * says "something went wrong" costs the user the same debugging session twice.
 */

/** Why the model stopped, normalised across providers (see ai/wire.ts `WireEvent.stopReason`). */
export type TurnStopReason = "length" | "stop" | "content_filter" | "tool_calls" | "other";

export interface TurnOutcomeContext {
  /** the provider's stop reason for this turn, when it reported one */
  stopReason?: TurnStopReason;
  /** did the model emit reasoning/thinking tokens this turn? */
  sawReasoning?: boolean;
  /** estimated prompt size INCLUDING tool schemas (see estimateRequestTokens) */
  promptTokens?: number;
  /** the window this endpoint is believed to serve */
  contextWindow?: number;
  /** e.g. "ollama" — names the knob in the remedy line */
  runtime?: string;
}

function budgetLine(ctx: TurnOutcomeContext): string {
  if (!ctx.promptTokens || !ctx.contextWindow) return "";
  const left = ctx.contextWindow - ctx.promptTokens;
  const pct = Math.round((ctx.promptTokens / ctx.contextWindow) * 100);
  const n = (v: number): string => v.toLocaleString("en-US");
  return ` The prompt used ~${n(ctx.promptTokens)} of ~${n(ctx.contextWindow)} tokens (${pct}%), leaving ~${n(Math.max(0, left))} for the answer.`;
}

function remedy(ctx: TurnOutcomeContext): string {
  const raise =
    ctx.runtime === "ollama"
      ? "raise the serving context (OLLAMA_CONTEXT_LENGTH, then restart ollama)"
      : "raise the model's context window";
  return ` Try /compress, a shorter request, fewer tools, or ${raise}.`;
}

/**
 * The turn produced NO text and NO tool call. Always returns a line — silence is never the
 * right answer here.
 */
export function emptyTurnNotice(ctx: TurnOutcomeContext = {}): string {
  if (ctx.stopReason === "length") {
    return `⚠ the model ran out of room before it answered: it was cut off at its context limit${ctx.sawReasoning ? " while still thinking" : ""}.${budgetLine(ctx)}${remedy(ctx)}`;
  }
  if (ctx.stopReason === "content_filter") {
    return "⚠ the model stopped on a content filter and returned nothing. Rephrase the request, or try another model.";
  }
  if (ctx.sawReasoning) {
    return `⚠ the model produced only reasoning this turn — no answer and no tool call.${budgetLine(ctx)} Ask again, or try a lower thinking effort (/think).`;
  }
  return `⚠ the model returned an empty reply.${budgetLine(ctx)} Ask again, or switch model with /worker.`;
}

/** The turn DID produce text, but the provider says it was cut short. */
export function truncationNotice(ctx: TurnOutcomeContext = {}): string {
  return `⚠ that answer was cut off at the model's context limit — it is incomplete.${budgetLine(ctx)}${remedy(ctx)}`;
}

/**
 * Estimate the tokens a request really costs: the messages AND the tool schemas.
 *
 * On the native transport the tool catalog travels in the request body's `tools:[]`, not in the
 * messages, so an estimate over message text alone missed ~6.5k tokens — it reported 755 where
 * the server counted 7,254. Everything that budgeted against that number (the preflight check,
 * the accounting row, the auto-compact ceiling) was wrong by the same factor.
 */
export function estimateRequestTokens(texts: readonly string[], tools?: unknown): number {
  const body = texts.join("\n");
  const toolBytes = tools === undefined ? 0 : JSON.stringify(tools).length;
  return Math.ceil((body.length + toolBytes) / 4);
}
