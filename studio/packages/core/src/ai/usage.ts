/**
 * ai/usage.ts — accumulating token usage across the frames of one streamed turn.
 *
 * A provider does not necessarily report a turn's usage in a single frame. Anthropic splits it:
 * `message_start` carries `input_tokens` plus the two prompt-cache counters, and `message_delta`
 * carries only `output_tokens`. Every consumer in this repo used to keep the LAST frame it saw,
 * so a Claude turn ended up recorded as `{inputTokens: 0, outputTokens: N}` with the cache
 * counters dropped — and on a long-context model the input side is usually the larger half of
 * the bill, so a configured USD cap under-counted by that whole half and tripped far too late.
 *
 * Merging rather than overwriting is the fix, and it belongs here rather than in each of the four
 * call sites, which is how they came to disagree in the first place.
 */

/** The normalized usage shape the wire parsers emit. */
export interface WireUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheRead?: number;
  cacheCreate?: number;
}

/**
 * Fold one frame's usage into what the turn has accumulated so far.
 *
 * A field is taken from `next` only when it actually carries information, so a later frame
 * reporting `input_tokens: 0` cannot erase the real count an earlier frame established. Counts
 * are REPLACED rather than summed: every provider reports running totals for the turn, so adding
 * them would double-count a provider that repeats the figure on each frame.
 */
export function mergeWireUsage(
  prev: WireUsage | undefined,
  next: WireUsage | undefined,
): WireUsage | undefined {
  if (!next) return prev;
  if (!prev) return next;
  const inputTokens = next.inputTokens > 0 ? next.inputTokens : prev.inputTokens;
  const outputTokens = next.outputTokens > 0 ? next.outputTokens : prev.outputTokens;
  const cacheRead = next.cacheRead ?? prev.cacheRead;
  const cacheCreate = next.cacheCreate ?? prev.cacheCreate;
  // `totalTokens` is only trusted from a frame that also carried a real count; otherwise it is
  // recomputed, so a delta frame's `0 + N` cannot become the turn's total.
  const totalFromNext = next.inputTokens > 0 || next.outputTokens > 0 ? next.totalTokens : 0;
  const totalTokens = Math.max(totalFromNext, inputTokens + outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheCreate !== undefined ? { cacheCreate } : {}),
  };
}
