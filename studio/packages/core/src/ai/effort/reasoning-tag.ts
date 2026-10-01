// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/effort/reasoning-tag.ts — keep a model's thinking out of its answer.
 *
 * Most reasoning models put their thinking in a SEPARATE field: Ollama spells it `reasoning`,
 * other OpenAI-compatible servers `reasoning_content`, Anthropic uses `thinking` blocks. Every
 * transport in this repo already reads those and routes them to a dimmed live channel.
 *
 * R1-style models do not. They emit their thinking INLINE, wrapped in `<think>…</think>`, in the
 * ordinary content stream — and a server that does not split the field for you hands it straight
 * through. `EffortCapability.reasoningTag` has recorded which models do this since the capability
 * type was written (`"think"` for DeepSeek R1, QwQ and Phi-4-reasoning; `"thought"` for EXAONE
 * Deep) and NOTHING has ever read it, so on those models the thinking landed in the transcript as
 * the answer.
 *
 * Two things go wrong when it does, and only one of them is cosmetic:
 *   - the visible answer is prefixed by paragraphs of deliberation;
 *   - that deliberation is fed to the TOOL-CALL SCANNER, so a model reasoning aloud about
 *     calling `write_file` can trip the text protocol into actually calling it.
 *
 * ── WHY A STATE MACHINE AND NOT A REGEX ────────────────────────────────────────────────────
 * This runs on a STREAM. A tag arrives split across chunk boundaries (`<thi` then `nk>`) as a
 * matter of course, so a per-chunk `replace()` sees neither half and passes both through. The
 * splitter therefore holds back only the longest tail that could still become a tag, and emits
 * everything else immediately — latency matters here, because this text is being painted live.
 *
 * PURE. No IO, no regex over unbounded input, no allocation per character.
 */

/** One chunk's worth of output, already separated. Either half may be empty. */
export interface ReasoningSplit {
  /** content for the transcript — and the only part the tool-call scanner should ever see. */
  text: string;
  /** content for the dimmed thinking channel. */
  reasoning: string;
}

export interface ReasoningTagSplitter {
  /** Feed the next content delta. */
  push(chunk: string): ReasoningSplit;
  /**
   * Flush at end of stream.
   *
   * An UNTERMINATED tag flushes as reasoning, not as text: a model that was cut off mid-thought
   * was still thinking, and promoting a truncated deliberation to "the answer" is the exact
   * failure this module exists to prevent. A partial tag that never completed (`"</thin"`) is
   * emitted verbatim — it is ordinary text that merely looked like the start of a tag.
   */
  end(): ReasoningSplit;
  /** true while inside the tag — for a caller that wants to label the live channel. */
  readonly inside: boolean;
}

const EMPTY: ReasoningSplit = { text: "", reasoning: "" };

/**
 * The longest suffix of `s` that is a proper prefix of `needle`.
 *
 * This is the whole streaming trick: that suffix might be the front half of a tag whose back
 * half is in the next chunk, so it is held back. Everything before it is safe to emit now.
 */
function heldSuffix(s: string, needle: string): number {
  const max = Math.min(s.length, needle.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(needle.slice(0, n))) return n;
  }
  return 0;
}

/**
 * A splitter for `<tag>…</tag>`.
 *
 * `tag` is the bare name (`"think"`, `"thought"`) — the same value
 * `EffortCapability.reasoningTag` carries. An empty or absent tag yields a splitter that is a
 * strict pass-through, so a caller can construct one unconditionally rather than branching.
 */
export function createReasoningTagSplitter(tag: string | undefined): ReasoningTagSplitter {
  if (!tag) {
    return {
      push: (chunk: string): ReasoningSplit => ({ text: chunk, reasoning: "" }),
      end: (): ReasoningSplit => EMPTY,
      inside: false,
    };
  }
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let inside = false;
  let buf = "";

  return {
    get inside(): boolean {
      return inside;
    },
    push(chunk: string): ReasoningSplit {
      buf += chunk;
      let text = "";
      let reasoning = "";
      for (;;) {
        const needle = inside ? close : open;
        const at = buf.indexOf(needle);
        if (at >= 0) {
          const before = buf.slice(0, at);
          if (inside) reasoning += before;
          else text += before;
          buf = buf.slice(at + needle.length);
          inside = !inside;
          continue;
        }
        // No complete tag. Emit everything except a tail that could still become one.
        const hold = heldSuffix(buf, needle);
        const flush = buf.slice(0, buf.length - hold);
        if (inside) reasoning += flush;
        else text += flush;
        buf = buf.slice(buf.length - hold);
        return { text, reasoning };
      }
    },
    end(): ReasoningSplit {
      const rest = buf;
      buf = "";
      if (rest === "") return EMPTY;
      // Inside ⇒ the thought was cut off; it is still a thought.
      return inside ? { text: "", reasoning: rest } : { text: rest, reasoning: "" };
    },
  };
}
