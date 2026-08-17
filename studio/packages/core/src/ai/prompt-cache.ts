/**
 * ai/prompt-cache.ts — actually ASKING for the prompt cache we already measure.
 *
 * This repo has a complete prompt-caching pipeline in one direction: `usageFromPayload`
 * normalizes three providers' cache counters, `AccountingRecord` persists them, and
 * `prometheus tokens report` prices the savings. It also ships a `prompt-caching` toggle
 * labelled `wired` and defaulting ON, plus a `shouldEnablePromptCaching` predicate.
 *
 * The predicate has zero callers, and `cache_control` appears nowhere in the repo except one
 * documentation string. So the toggle changed nothing, the report measured whatever the
 * provider happened to do on its own, and a user reading "prompt caching: on" was told
 * something that was not true.
 *
 * WHY THIS IS NOT ONE FLAG. The three providers disagree about whose job it is:
 *
 *  - **OpenAI** caches automatically for prompts over ~1024 tokens and offers no request-side
 *    control at all. There is nothing to send; asking is a no-op, and inventing a field would
 *    risk a 400 from the strict local servers that share this wire format.
 *  - **Anthropic** caches only what you MARK, with `cache_control: {type:"ephemeral"}` on a
 *    content block. That requires block-structured content, which is why this module exists at
 *    all — `Msg.content` is a flat string everywhere else in the repo.
 *  - **Gemini** requires a separate cached-content resource created ahead of time, which is a
 *    different API rather than a request field, and is therefore out of scope here.
 *
 * A single boolean would have to mean all three, so the dialect is named instead.
 *
 * WHAT GETS MARKED, and why it is the only safe choice: the longest STABLE PREFIX — the system
 * messages, and nothing else. A cache breakpoint is only worth anything if the bytes before it
 * are byte-identical next turn, and in an agentic loop the only part with that property is the
 * system prompt plus the tool preamble. Marking the last user message would create a fresh
 * cache entry every turn: pure cost, no hits, and the report would show the write charge as
 * though it were a saving.
 *
 * PURE: no fetch, no node. Producing the body is the transport's job.
 */
import type { EffortRuntime } from "./effort/rules.js";

/** How a provider wants to be told about caching, if at all. */
export type PromptCacheDialect =
  /** mark content blocks with `cache_control` (Anthropic, and gateways that proxy it). */
  | "anthropic-blocks"
  /** the provider caches on its own; there is nothing to send. */
  | "automatic"
  /** no caching, or none we can request over this wire. */
  | "none";

/**
 * Below this, caching is not worth requesting.
 *
 * Providers impose a minimum cacheable prefix (~1024 tokens for both OpenAI and Anthropic's
 * smaller models). Marking a shorter prefix earns a cache-WRITE charge and can never earn a
 * read, so the toggle would make short sessions more expensive — the exact opposite of what
 * the user turned it on for. ~4 chars/token, matching the estimator used everywhere else.
 */
export const PROMPT_CACHE_MIN_CHARS = 4096;

/** Which dialect this runtime speaks. */
export function cacheDialectFor(runtime: EffortRuntime): PromptCacheDialect {
  if (runtime === "anthropic") return "anthropic-blocks";
  if (runtime === "openai" || runtime === "gemini") return "automatic";
  // A local runner has no billing to save and no cache to speak of; an unknown cloud endpoint
  // might be an OpenAI-compatible gateway, which caches automatically if it caches at all.
  return runtime === "unknown" ? "automatic" : "none";
}

/** Whether this runtime benefits from prompt caching at all (for a status line). */
export function promptCachingSupported(runtime: EffortRuntime): boolean {
  return cacheDialectFor(runtime) !== "none";
}

/** One content block in the Anthropic-style shape (also accepted by OpenAI-format gateways). */
export interface CacheableTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** A message whose content may be a plain string or an array of blocks. */
export interface WireMsg {
  role: string;
  content: string | CacheableTextBlock[];
  [k: string]: unknown;
}

/**
 * Mark the stable prefix of a conversation as cacheable.
 *
 * Returns the messages UNCHANGED when there is nothing to gain — a dialect with no request
 * side, a prefix too short to be cacheable, or no system message to mark. Returning the input
 * untouched matters: a body that gained a block-shaped `content` for no reason is a body that
 * can 400 on a server that only accepts strings.
 */
export function applyPromptCache<T extends { role: string; content: string }>(
  messages: readonly T[],
  dialect: PromptCacheDialect,
): (T | WireMsg)[] {
  if (dialect !== "anthropic-blocks") return [...messages];
  // The stable prefix is the leading run of system messages. A system message appearing LATER
  // (the tool preamble is spliced in as one) is deliberately not included: everything before a
  // breakpoint is what gets cached, so a later breakpoint would cache the user's turn too.
  let lastSystem = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "system") lastSystem = i;
    else break;
  }
  if (lastSystem < 0) return [...messages];
  const prefixChars = messages.slice(0, lastSystem + 1).reduce((n, m) => n + m.content.length, 0);
  if (prefixChars < PROMPT_CACHE_MIN_CHARS) return [...messages];

  return messages.map((m, i) =>
    i === lastSystem
      ? ({
          ...m,
          content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }],
        } as WireMsg)
      : m,
  );
}

/**
 * Whether to request caching for this turn.
 *
 * Takes the RUNTIME rather than a provider name. The existing predicate took a provider string
 * and compared it against `["anthropic","openai","google","gemini"]`, while every catalogue in
 * this repo names those rows `claude`, `chatgpt` and `gemini` — so even once it had a caller,
 * the id it would naturally have been handed could never have matched. A runtime is derived
 * from the base URL, which is the thing that actually determines the wire.
 */
export function shouldRequestPromptCache(
  toggles: Record<string, boolean> | undefined,
  runtime: EffortRuntime,
): boolean {
  return toggles?.["prompt-caching"] !== false && promptCachingSupported(runtime);
}
