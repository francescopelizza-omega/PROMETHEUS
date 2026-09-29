/**
 * ai/wire.ts — the three wire formats, behind one seam.
 *
 * Every model request in this repo spoke exactly one protocol: OpenAI
 * `POST /v1/chat/completions` with `Authorization: Bearer`, SSE frames carrying
 * `choices[0].delta.content`. That is the right default — sixteen providers and every local
 * runner speak it — but it made two of the three biggest model vendors unreachable, and it
 * failed in a way that read like a bug rather than a gap:
 *
 *  - **Anthropic** serves `/v1/messages`, authenticates with `x-api-key` plus a required
 *    `anthropic-version` header, takes the system prompt as a TOP-LEVEL field rather than a
 *    message, REQUIRES `max_tokens`, and streams named events (`content_block_delta`) instead
 *    of choice deltas. A request built for OpenAI hits `/v1/chat/completions` on
 *    `api.anthropic.com` — an endpoint that does not exist — and 404s.
 *  - **Gemini** serves `…/models/{model}:streamGenerateContent?alt=sse`, puts the key in a
 *    header, calls the assistant role `model`, wraps text in `parts[]`, and reports usage as
 *    `usageMetadata`.
 *
 * WHY A DATA-SHAPED SEAM RATHER THAN THREE CLIENTS. This repo already has four copies of the
 * OpenAI transport, and they drifted — different bodies, different error handling, one that
 * never read an error body at all. Three protocols × four transports is twelve. So a format is
 * a small record of pure functions: build a URL, build headers, build a body, parse one event.
 * A transport keeps its own streaming loop, watchdog and retry, and asks the format what the
 * bytes mean.
 *
 * SCOPE: text generation, token usage, and TOOL CALLING — all three formats, natively.
 *
 * Tool calling used to be excluded here, on the reasoning that a half-built tool path which
 * silently drops a call is worse than an honest refusal. That was right about the risk and
 * wrong about the cost. `supportsTools: false` did not degrade Anthropic and Gemini politely;
 * it removed the product. Both fell back to the TEXT protocol — the transport written for
 * small local models that cannot function-call — so the two most capable models available to
 * this CLI were driven through its weakest channel: no parallel calls, no schema validation
 * by the provider, arguments recovered by scanning prose, and a per-turn token cost for
 * re-teaching the protocol in the preamble. An agentic CLI that cannot natively drive Claude
 * or Gemini is not a rival to the CLIs those vendors ship.
 *
 * So all three carry tools now, each in its own dialect, and the differences are real:
 *
 *  - **OpenAI** — `tools:[{type:"function",…}]`; calls stream as `delta.tool_calls[]` with
 *    the arguments arriving as JSON string FRAGMENTS keyed by array index; results go back
 *    as a `role:"tool"` message paired by `tool_call_id`.
 *  - **Anthropic** — `tools:[{name,description,input_schema}]`; a call is a `tool_use`
 *    CONTENT BLOCK inside the assistant turn, opened by `content_block_start` and filled by
 *    `input_json_delta` fragments; the result is a `tool_result` block in the next USER turn,
 *    paired by `tool_use_id`. There is no `tool` role.
 *  - **Gemini** — `tools:[{functionDeclarations:[…]}]` over a RESTRICTED schema subset (see
 *    `geminiSchema`); a call is a `functionCall` part delivered WHOLE rather than in
 *    fragments; the result is a `functionResponse` part paired by NAME, since Gemini issues
 *    no call ids at all.
 *
 * The neutral shapes (`WireToolCall`, `WireTool`, `WireEvent.toolCall`) are what keeps the
 * transport from learning any of that.
 *
 * PURE: no fetch, no node, no state.
 */
import type { EffortRuntime } from "./effort/rules.js";

/**
 * One tool call the model asked for, in the neutral shape.
 *
 * `argsJson` is the RAW JSON text rather than a parsed object because two of the three
 * formats stream it in fragments, and because a model that emits invalid JSON must be
 * reportable as such — parsing here would turn a recoverable "the model wrote bad JSON"
 * into an exception thrown from inside a stream parser.
 */
export interface WireToolCall {
  id: string;
  name: string;
  argsJson: string;
}

/** A message as the rest of the repo represents it. */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** on an `assistant` turn: the calls it made. */
  toolCalls?: readonly WireToolCall[];
  /** on a `tool` turn: which call this is the result of. */
  toolCallId?: string;
  /** on a `tool` turn: the tool's name (Gemini pairs by NAME, not by id). */
  toolName?: string;
}

/** A tool definition in the neutral shape; each format renders its own dialect. */
export interface WireTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

/** What one parsed stream event contributed. */
/**
 * One tool call, or one fragment of one, as it came off the wire.
 *
 * `index` groups fragments belonging to the SAME call — that is how OpenAI and Anthropic stream
 * a call whose JSON arguments arrive in pieces.
 *
 * `complete` says the fragment is the WHOLE call, so it must never be merged into anything.
 * Gemini delivers each `functionCall` part entire, and its index is the part's position within
 * the chunk it arrived in — which is 0 for every call when the server sends one call per chunk.
 * Without this flag the reader keyed purely on `index` and two different calls landed in the
 * same accumulator slot: the second name overwrote the first and the two argument objects were
 * concatenated into `{"path":"a.txt"}{"path":"."}`, which does not parse. Both calls were
 * destroyed and the model was told its own output was malformed. Reproduced end to end against
 * the real `LLMClient.turn()` with a live HTTP server.
 */
export interface WireToolCallFragment {
  index: number;
  id?: string;
  name?: string;
  argsFragment?: string;
  /** the fragment IS the entire call — never merge it with another (Gemini). */
  complete?: boolean;
}

export interface WireEvent {
  /** incremental assistant text, if any. */
  delta?: string;
  /**
   * an incremental tool call. `index` groups fragments belonging to the same call; `id` and
   * `name` arrive once (on the opening frame) and `argsFragment` accumulates.
   */
  toolCall?: WireToolCallFragment;
  /**
   * EVERY tool call carried by this frame, when a provider batches more than one into it.
   *
   * `toolCall` is a single object, and both parsers used to take exactly one entry per frame —
   * OpenAI read `tool_calls[0]`, Gemini took the first `functionCall` part — so a server that
   * batches parallel calls into ONE frame lost all but the first. Gemini delivers parallel
   * function calls as several `functionCall` parts inside one candidate, so this was a real loss
   * there: the agent ran 1 of N requested actions, and because the thread sent back also held
   * only the survivor, the model had no way to notice the others had vanished.
   *
   * `toolCall` stays populated with the FIRST entry so existing readers keep working; a reader
   * that wants them all reads this instead. Present whenever the frame carried any call.
   */
  toolCalls?: ReadonlyArray<WireToolCallFragment>;
  /** token usage, if this frame carried it. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheRead?: number;
    cacheCreate?: number;
  };
  /** the stream is finished (the format's terminal marker). */
  done?: boolean;
  /**
   * Why the model STOPPED, when the provider says so (OpenAI `finish_reason`, Anthropic
   * `stop_reason`). `"length"` is the one that matters: the reply was CUT OFF because the
   * context (or a max-token cap) ran out.
   *
   * It is not an `error` — the HTTP call succeeded and a truncated answer is still an answer —
   * but it must not be silence either. Dropping it is how a local thinking model that spent
   * its whole remaining window on reasoning ended a turn with no text, no tool call and no
   * explanation: measured 2026-09-24 against ollama (`n_tokens = 8191, truncated = 1`), where
   * the user saw only the thinking stream and then nothing at all.
   */
  stopReason?: "length" | "stop" | "content_filter" | "tool_calls" | "other";
  /**
   * The provider reported a failure MID-STREAM, after a 200.
   *
   * All three formats can do this and all three used to parse it to silence: Anthropic sends
   * `{"type":"error","error":{…}}` on overload or a mid-generation fault, OpenAI-compatible
   * servers send a bare `{"error":{…}}` frame, and Gemini reports a blocked prompt or a
   * non-STOP `finishReason`. The HTTP status is already 200 by then, so retry never sees it
   * and neither does the error path — the turn simply ended with an empty answer and no
   * explanation, which reads as the model refusing to speak.
   */
  error?: string;
}

/** Map a provider's stop/finish reason onto the small set the agent acts on. */
export function normalizeStopReason(raw: string): NonNullable<WireEvent["stopReason"]> {
  const r = raw.toLowerCase();
  // Anthropic says "max_tokens", OpenAI and ollama say "length" — the same event.
  if (r === "length" || r === "max_tokens" || r === "model_length") return "length";
  if (r === "stop" || r === "end_turn" || r === "stop_sequence") return "stop";
  if (r === "content_filter" || r === "safety" || r === "refusal") return "content_filter";
  if (r === "tool_calls" || r === "tool_use" || r === "function_call") return "tool_calls";
  return "other";
}

export interface WireBodyOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** ask for a usage frame where the format needs to be told. */
  includeUsage?: boolean;
  /** tools to expose this turn. Omitted or empty ⇒ no tool fields go on the wire at all. */
  tools?: readonly WireTool[];
}

/** One protocol, as data. */
export interface WireFormat {
  id: "openai" | "anthropic" | "gemini";
  /** whether THIS implementation can carry tool definitions (see the header). */
  supportsTools: boolean;
  /** the full URL to POST to. */
  url(baseUrl: string, model: string): string;
  /** auth + protocol headers. `key` is empty for a local endpoint. */
  headers(key: string): Record<string, string>;
  /** the request body object (the caller stringifies). */
  body(messages: readonly WireMessage[], opts: WireBodyOptions): Record<string, unknown>;
  /** interpret one SSE `data:` payload. */
  parse(payload: string): WireEvent;
  /**
   * Interpret a WHOLE non-streamed response body.
   *
   * Plenty of OpenAI-compatible servers, proxies and gateways ignore `stream: true` and answer
   * 200 with an ordinary JSON completion. The reader below looks only for `data:` lines, found
   * none, and the turn ended with no text, no usage and no error — a completely silent answer,
   * indistinguishable from the model declining. Reproduced against a real HTTP server.
   */
  parseWhole(body: string): WireEvent;
}

/* ── helpers ───────────────────────────────────────────────────────────────*/

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
}
function trimSlash(u: string): string {
  return u.replace(/\/+$/, "");
}
function parseJson(payload: string): Record<string, unknown> | null {
  try {
    const o: unknown = JSON.parse(payload);
    return isRecord(o) ? o : null;
  } catch {
    return null;
  }
}

/**
 * Pull a human-readable message out of a provider's error object.
 *
 * Shapes differ (`{error:{message}}`, `{error:{type,message}}`, `{message}`) but every one of
 * them carries a message; anything unrecognised degrades to a stable sentence rather than to
 * `undefined`, because an error that cannot be described must still be REPORTED.
 */
function errorMessage(o: Record<string, unknown>): string {
  const e = isRecord(o.error) ? o.error : o;
  const msg = typeof e.message === "string" && e.message ? e.message : "";
  const kind = typeof e.type === "string" && e.type ? e.type : "";
  if (msg && kind) return `${kind}: ${msg}`;
  return msg || kind || "the provider reported an error but sent no message";
}

/**
 * Whether tool fields belong on this request at all.
 *
 * An EMPTY array is not the same as none: `tools: []` is rejected outright by Anthropic and
 * makes some local OpenAI shims 400, and it is the shape a turn takes whenever the policy
 * exposes nothing. Absent is the only universally safe rendering of "no tools".
 */
function hasTools(opts: WireBodyOptions): boolean {
  return (opts.tools?.length ?? 0) > 0;
}

/**
 * Read a message's text when the content may ALREADY be block-shaped.
 *
 * `ai/prompt-cache.ts` rewrites the marked system message's `content` from a string to
 * `[{type:"text",text,cache_control}]`, and the transports hand the result straight to
 * `body()` (through an `as never`, so the type checker never saw it). Anything that did
 * `String(content)` on that got the literal `"[object Object]"` — see `anthropicSystem`.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/** Parse a model-produced argument string, tolerating the empty/blank no-argument case. */
function parseArgs(argsJson: string): Record<string, unknown> {
  const t = argsJson.trim();
  if (!t) return {};
  const o = parseJson(t);
  return o ?? {};
}

/** A turn reduced to the two roles Anthropic and Gemini both accept. */
interface AlternatingTurn {
  role: "user" | "assistant";
  content: string;
  /** format-specific content blocks/parts, when the turn carries more than text. */
  blocks?: Record<string, unknown>[];
}

/**
 * Coerce a thread into the strict user/assistant ALTERNATION both formats require.
 *
 * OpenAI accepts any sequence of roles; Anthropic and Gemini do not. Both reject a request
 * whose `messages` repeat a role, and Anthropic additionally rejects one that opens on the
 * assistant. That is not an edge case here — it is the NORMAL shape of an agentic turn:
 *
 *     user "do the thing" → assistant "calling a tool" → tool "result" → user "and now?"
 *
 * `tool` has no role of its own in either format, so it reads as user-supplied context, and
 * the moment it does there are two `user` turns back to back. So the SECOND round of every
 * tool loop 400'd — and since `ai/wire.ts` reports `supportsTools: false` for these two, the
 * text protocol is the ONLY path they have. Claude and Gemini could not complete a single
 * agentic task, while a one-shot chat (which never produces a second user turn) worked
 * perfectly, which is why this looked like it was fine.
 *
 * Merging rather than dropping is what keeps the tool result in front of the model: a
 * dropped turn is the invisible failure `flattenToolRoles` was written to prevent, and it
 * would be reintroduced here. A leading assistant turn — which a restored session can open
 * with — is folded into the first user turn for the same reason.
 */
function alternate(
  messages: readonly WireMessage[],
  /** render one message to this format's content blocks/parts. */
  toBlocks?: (m: WireMessage) => Record<string, unknown>[],
): AlternatingTurn[] {
  const out: AlternatingTurn[] = [];
  const join = (a: string, b: string): string => (a && b ? `${a}\n\n${b}` : a || b);
  for (const m of messages) {
    if (m.role === "system") continue;
    const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
    const blocks = toBlocks?.(m);
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      // Blank-line separated so the two turns stay legible as separate contributions.
      prev.content = join(prev.content, contentText(m.content));
      if (blocks) prev.blocks = [...(prev.blocks ?? []), ...blocks];
      continue;
    }
    out.push({ role, content: contentText(m.content), ...(blocks ? { blocks } : {}) });
  }
  // Anthropic: "the first message must use the user role". Gemini agrees.
  if (out.length > 0 && out[0]?.role === "assistant") {
    const head = out.shift() as AlternatingTurn;
    const next = out[0];
    if (next) {
      next.content = join(head.content, next.content);
      if (head.blocks) next.blocks = [...head.blocks, ...(next.blocks ?? [])];
    } else {
      out.push({
        role: "user",
        content: head.content,
        ...(head.blocks ? { blocks: head.blocks } : {}),
      });
    }
  }
  return out;
}

/* ── OpenAI — the existing behaviour, unchanged ────────────────────────────*/

export const OPENAI_WIRE: WireFormat = {
  id: "openai",
  supportsTools: true,
  url(baseUrl) {
    const base = trimSlash(baseUrl);
    // Tolerate a baseUrl that ALREADY ends in /v1 — the engine's `localai endpoints` returns
    // e.g. "http://localhost:11434/v1", and a naive join emits ".../v1/v1/chat/completions",
    // which answers "404 page not found" and kills chat.
    return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  },
  headers(key): Record<string, string> {
    return key ? { authorization: `Bearer ${key}` } : {};
  },
  body(messages, opts) {
    return {
      model: opts.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        // The PAIRED form: a strict endpoint requires the assistant turn that made the calls
        // to carry them, and requires each result to name the call it answers. Emitted only
        // when present, so a plain chat body is byte-identical to what it always was.
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.argsJson },
              })),
            }
          : {}),
        ...(m.role === "tool" && m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      stream: true,
      ...(hasTools(opts)
        ? {
            tools: opts.tools?.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: "auto",
          }
        : {}),
      ...(opts.includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    };
  },
  parseWhole(body) {
    const o = parseJson(body);
    if (!o) return {};
    if (isRecord(o.error)) return { error: errorMessage(o) };
    const out: WireEvent = {};
    const choices = o.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0];
      const message = isRecord(first) ? first.message : undefined;
      // `message.content` is the non-streamed shape; `text` is the older completions one.
      const text = isRecord(message)
        ? typeof message.content === "string"
          ? message.content
          : ""
        : isRecord(first) && typeof first.text === "string"
          ? first.text
          : "";
      if (text) out.delta = text;
    }
    const usage = o.usage;
    if (isRecord(usage)) {
      const inTok = num(usage.prompt_tokens) ?? 0;
      const outTok = num(usage.completion_tokens) ?? 0;
      out.usage = { inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok };
    }
    return out;
  },
  parse(payload) {
    if (payload === "[DONE]") return { done: true };
    const o = parseJson(payload);
    if (!o) return {};
    // A mid-stream failure arrives as its own frame, AFTER a 200 — so neither the retry
    // classifier nor the error path ever saw it and the turn just ended empty.
    if (isRecord(o.error)) return { error: errorMessage(o) };
    const out: WireEvent = {};
    const choices = o.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as {
        delta?: { content?: unknown; tool_calls?: unknown };
        text?: unknown;
      };
      const fr = (first as { finish_reason?: unknown }).finish_reason;
      if (typeof fr === "string" && fr) out.stopReason = normalizeStopReason(fr);
      const c = first.delta?.content;
      if (typeof c === "string" && c) out.delta = c;
      else if (typeof first.text === "string" && first.text) out.delta = first.text;
      // Arguments arrive as JSON string FRAGMENTS, keyed by `index` — a single call is
      // routinely spread over a dozen frames, and two parallel calls interleave. The index
      // is what keeps them apart; it is not optional bookkeeping.
      const tc = first.delta?.tool_calls;
      if (Array.isArray(tc) && tc.length > 0) {
        // EVERY entry, not just tc[0]: a server may batch a turn's parallel calls into one frame.
        const parsed: NonNullable<WireEvent["toolCalls"]>[number][] = [];
        for (let k = 0; k < tc.length; k++) {
          const f = tc[k];
          if (!isRecord(f)) continue;
          const fn = isRecord(f.function) ? f.function : undefined;
          const frag = fn && typeof fn.arguments === "string" ? fn.arguments : undefined;
          parsed.push({
            index: num(f.index) ?? k,
            ...(typeof f.id === "string" && f.id ? { id: f.id } : {}),
            ...(fn && typeof fn.name === "string" && fn.name ? { name: fn.name } : {}),
            ...(frag !== undefined ? { argsFragment: frag } : {}),
          });
        }
        if (parsed.length > 0) {
          out.toolCalls = parsed;
          out.toolCall = parsed[0];
        }
      }
    }
    const u = o.usage;
    if (isRecord(u)) {
      const inTok = num(u.prompt_tokens);
      const outTok = num(u.completion_tokens);
      if (inTok !== undefined || outTok !== undefined) {
        const details = u.prompt_tokens_details;
        const cacheRead = isRecord(details) ? num(details.cached_tokens) : undefined;
        out.usage = {
          inputTokens: inTok ?? 0,
          outputTokens: outTok ?? 0,
          totalTokens: num(u.total_tokens) ?? (inTok ?? 0) + (outTok ?? 0),
          ...(cacheRead !== undefined ? { cacheRead } : {}),
        };
      }
    }
    return out;
  },
};

/* ── Anthropic Messages ────────────────────────────────────────────────────*/

/** The API version Anthropic requires on every request. Not optional. */
export const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Anthropic REQUIRES `max_tokens`; there is no "as much as you like".
 *
 * A default has to exist or every request without an explicit cap 400s — but the default this
 * repo shipped was **4096**, chosen because it was "small enough not to surprise a bill". That
 * is a COST choice wearing a capability choice's clothes, and it was the only place in the
 * entire codebase that truncated a model's answer: OpenAI omits `max_tokens`, Gemini omits
 * `generationConfig`, and ollama (driven through the OpenAI /v1 shim) gets no output cap at
 * all. No caller ever passes `maxTokens`, so EVERY Claude turn from EVERY surface stopped at
 * 4,096 tokens on models that serve sixteen times that.
 *
 * A cap that silently ends the answer is not a safety device — it is the same class of bug as
 * the 8192 serving context that produced empty turns on 2026-09-24 (CLAUDE.md §2.8). The
 * default is now the model's OWN documented maximum.
 *
 * Why a table and not one big number: `max_tokens` above what the model allows is a 400, so
 * "just send a million" breaks every request instead of none. Entries are the published output
 * ceilings; `ANTHROPIC_FALLBACK_MAX_TOKENS` covers an unrecognised model conservatively enough
 * to be accepted by any of them.
 *
 * ── 2026-09-25: THE FIRST VERSION OF THIS TABLE WAS STILL WRONG ─────────────────────────────
 *
 * Replacing the flat 4096 fixed the worst of it and then left four under-caps behind, because
 * the rows were written for model FAMILIES while the ceilings move per GENERATION. Measured
 * against the published table for every id this repo actually ships
 * (`ai/providers/providers.config.json`):
 *
 *   claude-opus-4-8   sent 32,000   real 128,000   ← and this is the DEFAULT Opus in the catalog
 *   claude-fable-5    sent  8,192   real 128,000   ← matched NO row at all, fell to the fallback
 *   claude-sonnet-4-6 sent 64,000   real 128,000
 *   claude-haiku-4-5  sent 64,000   real  64,000   ← the only shipped model that was right
 *
 * `claude-fable-5` is the instructive one: the fallback's comment reasons about "a model this
 * table has never heard of", which is sound for an id arriving from a user's config and wrong
 * for one the repo ships in its own catalog. A 15.6× under-cap on a listed model is not a
 * conservative default, it is a missing row.
 *
 * THE RULE THAT KEEPS THIS TRUE: a model id in `providers.config.json` must have its own row
 * here. The fallback is for ids this repo does not ship. `wire.test.ts` asserts that.
 *
 * ORDER IS LOAD-BEARING — `anthropicMaxTokensFor` takes the FIRST match, so the specific
 * generations must precede the family catch-alls. The catch-alls are kept, not replaced: 32,000
 * is genuinely correct for the legacy `claude-opus-4` and `claude-opus-4-1`.
 *
 * 128,000 is safe to send from here only because `ANTHROPIC_WIRE.body` sets `stream: true`
 * unconditionally (see below) — the vendor requires streaming at that ceiling.
 */
export const ANTHROPIC_MAX_OUTPUT: readonly { re: RegExp; maxTokens: number }[] = Object.freeze([
  // ── the 128K generation, most specific first ──────────────────────────────
  { re: /^claude-(fable|mythos)-5/, maxTokens: 128_000 },
  { re: /^claude-opus-4-[678]/, maxTokens: 128_000 },
  { re: /^claude-(opus|sonnet)-5/, maxTokens: 128_000 },
  { re: /^claude-sonnet-4-6/, maxTokens: 128_000 },
  // ── 64K ───────────────────────────────────────────────────────────────────
  { re: /^claude-(sonnet|haiku)-4-5/, maxTokens: 64_000 },
  // `haiku-5` is NOT a guess and NOT in the published table — it is here to preserve behaviour.
  // The old row was `^claude-(sonnet|haiku|opus)-5`, so splitting opus/sonnet out to 128K would
  // have dropped haiku-5 through to the 8,192 fallback. Keeping its previous 64,000 changes
  // nothing about a model nobody has documented, and matches haiku-4-5's real ceiling.
  { re: /^claude-haiku-5/, maxTokens: 64_000 },
  // ── family catch-alls. `opus-4` / `opus-4-1` really are 32K; `opus-4-5` has
  //    no published output ceiling in the reference, so it lands here rather
  //    than being given a number nobody has verified.
  { re: /^claude-opus-4/, maxTokens: 32_000 },
  { re: /^claude-(sonnet|haiku)-4/, maxTokens: 64_000 },
  { re: /^claude-3-7/, maxTokens: 64_000 },
  { re: /^claude-3-5/, maxTokens: 8_192 },
  { re: /^claude-3/, maxTokens: 4_096 },
]);

/**
 * The default for a Claude model this table has never heard of.
 *
 * 8192 rather than 64000 on purpose: an unknown model is most likely a NEW one (where a bigger
 * ceiling would be accepted) or an OLD one (where it would 400). Refusing to guess high keeps
 * an unrecognised model working; the table is how a model gets its real ceiling.
 */
export const ANTHROPIC_FALLBACK_MAX_TOKENS = 8_192;

/** @deprecated The old flat cap. Kept only so an external importer does not break. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = ANTHROPIC_FALLBACK_MAX_TOKENS;

/** The published output ceiling for a Claude model id. */
export function anthropicMaxTokensFor(modelId: string): number {
  const id = modelId.toLowerCase();
  return (
    ANTHROPIC_MAX_OUTPUT.find((r) => r.re.test(id))?.maxTokens ?? ANTHROPIC_FALLBACK_MAX_TOKENS
  );
}

/**
 * Render one message as Anthropic content blocks.
 *
 * Anthropic has NO `tool` role. A result is a `tool_result` block carried by the next USER
 * turn and paired by `tool_use_id` — which is why `alternate` merging matters here: several
 * parallel results land in one user turn, exactly as the API expects.
 */
function anthropicBlocks(m: WireMessage): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (m.role === "tool") {
    blocks.push({
      type: "tool_result",
      // A result with no id cannot be paired, and Anthropic rejects the request rather than
      // ignoring the block — so an unpaired result degrades to plain text instead.
      ...(m.toolCallId ? { tool_use_id: m.toolCallId } : {}),
      content: contentText(m.content),
    });
    return m.toolCallId ? blocks : [{ type: "text", text: contentText(m.content) }];
  }
  const text = contentText(m.content);
  if (text) blocks.push({ type: "text", text });
  for (const c of m.toolCalls ?? []) {
    // `input` is an OBJECT here, not the JSON text OpenAI takes.
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: parseArgs(c.argsJson) });
  }
  return blocks;
}

/**
 * Build the top-level `system` field, PRESERVING any cache breakpoint already on it.
 *
 * `ai/prompt-cache.ts` marks the stable system prefix by replacing its `content` string with
 * `[{type:"text",text,cache_control:{type:"ephemeral"}}]`. This function used to join the
 * system messages' `content` values with `\n\n`, so a marked message contributed the string
 * `"[object Object]"` — and since the marking triggers at 4096 characters, and an agentic
 * system prompt with a tool preamble always exceeds that, EVERY Claude turn in this CLI sent
 * that literal as its entire system prompt. No instructions, no tool preamble, no identity;
 * the model was left to guess, and the failure was invisible because the request succeeded.
 *
 * Anthropic accepts `system` as either a string or an array of blocks, so the marked form is
 * passed through as blocks — which is also the only way the cache is actually requested.
 */
function anthropicSystem(
  messages: readonly WireMessage[],
): string | Record<string, unknown>[] | undefined {
  const blocks: Record<string, unknown>[] = [];
  let marked = false;
  for (const m of messages) {
    if (m.role !== "system") continue;
    const c = m.content as unknown;
    if (Array.isArray(c)) {
      marked = true;
      for (const b of c) if (isRecord(b)) blocks.push(b);
    } else {
      const text = contentText(c);
      if (text) blocks.push({ type: "text", text });
    }
  }
  if (blocks.length === 0) return undefined;
  if (marked) return blocks;
  return blocks.map((b) => String(b.text ?? "")).join("\n\n");
}

/** Emit the cheapest legal rendering: a bare string when a turn is only text. */
function anthropicContent(turn: AlternatingTurn): string | Record<string, unknown>[] {
  const blocks = turn.blocks ?? [];
  if (blocks.every((b) => b.type === "text")) return turn.content;
  return blocks;
}

export const ANTHROPIC_WIRE: WireFormat = {
  id: "anthropic",
  supportsTools: true,
  url(baseUrl) {
    const base = trimSlash(baseUrl);
    return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  },
  headers(key): Record<string, string> {
    // `x-api-key`, NOT a bearer — and the version header is mandatory.
    return {
      ...(key ? { "x-api-key": key } : {}),
      "anthropic-version": ANTHROPIC_VERSION,
    };
  },
  body(messages, opts) {
    // The system prompt is a TOP-LEVEL field. Left as a message it is rejected outright:
    // Anthropic's `messages` accepts only `user` and `assistant`.
    const system = anthropicSystem(messages);
    // A `tool` result has no role of its own here; it reads as user-supplied context, which
    // is what it is from the model's point of view. `alternate` then enforces the strict
    // user/assistant alternation the API requires — see its header.
    const turns = alternate(messages, anthropicBlocks).map((t) => ({
      role: t.role,
      content: anthropicContent(t),
    }));
    return {
      model: opts.model,
      // Required by the API. Omitting it is a 400, not a default.
      max_tokens: opts.maxTokens ?? anthropicMaxTokensFor(opts.model),
      messages: turns,
      stream: true,
      ...(system ? { system } : {}),
      ...(hasTools(opts)
        ? {
            // `input_schema`, not `parameters`, and no `{type:"function"}` envelope.
            tools: opts.tools?.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
            tool_choice: { type: "auto" },
          }
        : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
  },
  parseWhole(body) {
    const o = parseJson(body);
    if (!o) return {};
    if (isRecord(o.error) || o.type === "error") return { error: errorMessage(o) };
    const out: WireEvent = {};
    const content = o.content;
    if (Array.isArray(content)) {
      const text = content
        .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : ""))
        .join("");
      if (text) out.delta = text;
    }
    const usage = o.usage;
    if (isRecord(usage)) {
      const inTok = num(usage.input_tokens) ?? 0;
      const outTok = num(usage.output_tokens) ?? 0;
      out.usage = {
        inputTokens: inTok,
        outputTokens: outTok,
        totalTokens: inTok + outTok,
        ...(num(usage.cache_read_input_tokens) !== undefined
          ? { cacheRead: num(usage.cache_read_input_tokens) as number }
          : {}),
        ...(num(usage.cache_creation_input_tokens) !== undefined
          ? { cacheCreate: num(usage.cache_creation_input_tokens) as number }
          : {}),
      };
    }
    return out;
  },
  parse(payload) {
    const o = parseJson(payload);
    if (!o) return {};
    const type = typeof o.type === "string" ? o.type : "";
    // `overloaded_error`, `api_error`, and every mid-generation fault arrive here.
    if (type === "error") return { error: errorMessage(o) };
    if (type === "message_stop") return { done: true };
    // A call OPENS here, carrying its id and name and an empty `input` — the arguments
    // themselves arrive later as `input_json_delta` fragments. Both frames key on the same
    // `index`, which is the only thing tying two parallel calls apart.
    if (type === "content_block_start") {
      const b = o.content_block;
      if (isRecord(b) && b.type === "tool_use") {
        return {
          toolCall: {
            index: num(o.index) ?? 0,
            ...(typeof b.id === "string" ? { id: b.id } : {}),
            ...(typeof b.name === "string" ? { name: b.name } : {}),
          },
        };
      }
      return {};
    }
    if (type === "content_block_delta") {
      const d = o.delta;
      if (!isRecord(d)) return {};
      // Two delta shapes share this frame type. `partial_json` is a fragment of the tool
      // arguments; treating it as prose would print raw JSON at the user and lose the call.
      if (typeof d.partial_json === "string") {
        return { toolCall: { index: num(o.index) ?? 0, argsFragment: d.partial_json } };
      }
      const text = d.text;
      return typeof text === "string" && text ? { delta: text } : {};
    }
    /**
     * Usage arrives TWICE and neither frame is complete on its own: `message_start` carries
     * input_tokens (+ the two cache counters), `message_delta` carries only output_tokens.
     *
     * The note here used to say the caller "keeps the last, which is the complete one". It is
     * not: the last frame has `input_tokens: 0` and no cache fields, so a consumer that
     * overwrites ends every Claude turn holding `{inputTokens: 0, outputTokens: N}`. Callers must
     * MERGE the frames — `mergeWireUsage` in ai/usage.ts does it — which is why both are emitted
     * rather than one synthesised total.
     */
    const usageFrom = (u: unknown): WireEvent["usage"] | undefined => {
      if (!isRecord(u)) return undefined;
      const inTok = num(u.input_tokens);
      const outTok = num(u.output_tokens);
      if (inTok === undefined && outTok === undefined) return undefined;
      const cacheRead = num(u.cache_read_input_tokens);
      const cacheCreate = num(u.cache_creation_input_tokens);
      return {
        inputTokens: inTok ?? 0,
        outputTokens: outTok ?? 0,
        totalTokens: (inTok ?? 0) + (outTok ?? 0),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheCreate !== undefined ? { cacheCreate } : {}),
      };
    };
    if (type === "message_start") {
      const msg = o.message;
      const u = isRecord(msg) ? usageFrom(msg.usage) : undefined;
      return u ? { usage: u } : {};
    }
    if (type === "message_delta") {
      const u = usageFrom(o.usage);
      // `message_delta` is also where Anthropic reports WHY it stopped ("max_tokens" =
      // truncated), the counterpart of OpenAI's finish_reason.
      const d = isRecord(o.delta) ? o.delta : undefined;
      const sr = d && typeof d.stop_reason === "string" ? d.stop_reason : undefined;
      return {
        ...(u ? { usage: u } : {}),
        ...(sr ? { stopReason: normalizeStopReason(sr) } : {}),
      };
    }
    return {};
  },
};

/* ── Gemini generateContent ────────────────────────────────────────────────*/

/**
 * Gemini's `parameters` is an OpenAPI SUBSET, not JSON Schema, and it is strict about it.
 *
 * Two differences bite. `type` is a protobuf ENUM, so it is `"STRING"` and not `"string"`.
 * And unknown keys are rejected rather than ignored — `additionalProperties`, `$schema`,
 * `default` and the `exclusive*` bounds all appear in schemas this repo generates and all
 * produce a 400 with a message that names none of them. So the schema is rebuilt from the
 * keys Gemini documents, recursively, and everything else is dropped.
 */
function geminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof schema.type === "string") out.type = schema.type.toUpperCase();
  if (typeof schema.description === "string") out.description = schema.description;
  if (typeof schema.format === "string") out.format = schema.format;
  if (typeof schema.nullable === "boolean") out.nullable = schema.nullable;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map((v) => String(v));
  const items = geminiSchema(schema.items);
  if (items) out.items = items;
  if (isRecord(schema.properties)) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      const p = geminiSchema(v);
      if (p) props[k] = p;
    }
    out.properties = props;
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    out.required = schema.required.filter((r) => typeof r === "string");
  }
  return out;
}

/** Render one message as Gemini `parts`. */
function geminiParts(m: WireMessage): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  if (m.role === "tool") {
    // Gemini issues NO call ids, so a result is paired by the function's NAME. Without the
    // name there is nothing to pair with, and the part is rejected — so it degrades to text.
    if (m.toolName) {
      return [
        { functionResponse: { name: m.toolName, response: { result: contentText(m.content) } } },
      ];
    }
    return [{ text: contentText(m.content) }];
  }
  const gtext = contentText(m.content);
  if (gtext) parts.push({ text: gtext });
  for (const c of m.toolCalls ?? []) {
    parts.push({ functionCall: { name: c.name, args: parseArgs(c.argsJson) } });
  }
  return parts;
}

export const GEMINI_WIRE: WireFormat = {
  id: "gemini",
  supportsTools: true,
  url(baseUrl, model) {
    const base = trimSlash(baseUrl);
    // The model is part of the PATH, and `alt=sse` is what makes the response a stream rather
    // than a JSON array delivered at the end.
    const root = /\/v1(beta)?$/.test(base) ? base : `${base}/v1beta`;
    return `${root}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  },
  headers(key): Record<string, string> {
    // The key rides a header rather than the query string: a URL is logged by proxies and
    // shows up in error messages, and this one would carry the secret.
    return key ? { "x-goog-api-key": key } : {};
  },
  body(messages, opts) {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => contentText(m.content))
      .join("\n\n");
    const contents = alternate(messages, geminiParts).map((m) => ({
      // Gemini calls the assistant `model`; sending `assistant` is a 400.
      role: m.role === "assistant" ? "model" : "user",
      parts: m.blocks ?? [{ text: m.content }],
    }));
    return {
      contents,
      ...(hasTools(opts)
        ? {
            // ONE `tools` entry holding every declaration — not one entry per tool.
            tools: [
              {
                functionDeclarations: opts.tools?.map((t) => ({
                  name: t.name,
                  description: t.description,
                  ...(() => {
                    const p = geminiSchema(t.parameters);
                    // A no-argument tool must omit `parameters` entirely: an OBJECT schema
                    // with an empty `properties` map is rejected.
                    return p && Object.keys((p.properties as object) ?? {}).length > 0
                      ? { parameters: p }
                      : {};
                  })(),
                })),
              },
            ],
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          }
        : {}),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(opts.temperature !== undefined || opts.maxTokens !== undefined
        ? {
            generationConfig: {
              ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
              ...(opts.maxTokens !== undefined ? { maxOutputTokens: opts.maxTokens } : {}),
            },
          }
        : {}),
    };
  },
  parseWhole(body) {
    const o = parseJson(body);
    if (!o) return {};
    if (isRecord(o.error)) return { error: errorMessage(o) };
    const out: WireEvent = {};
    const candidates = o.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const first = candidates[0];
      const content = isRecord(first) ? first.content : undefined;
      const parts = isRecord(content) ? content.parts : undefined;
      if (Array.isArray(parts)) {
        const text = parts
          .map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : ""))
          .join("");
        if (text) out.delta = text;
      }
    }
    const meta = o.usageMetadata;
    if (isRecord(meta)) {
      const inTok = num(meta.promptTokenCount) ?? 0;
      const outTok = num(meta.candidatesTokenCount) ?? 0;
      out.usage = { inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok };
    }
    return out;
  },
  parse(payload) {
    const o = parseJson(payload);
    if (!o) return {};
    if (isRecord(o.error)) return { error: errorMessage(o) };
    /**
     * Gemini fails in two shapes that are NOT errors, and both looked like silence.
     *
     * A prompt refused by the safety filter comes back as `promptFeedback.blockReason` with
     * no candidates at all, and a generation cut short reports a `finishReason` other than
     * STOP (SAFETY, RECITATION, MAX_TOKENS). Both are 200 responses, so the turn simply
     * ended with an empty answer — indistinguishable, to the user, from the model declining.
     */
    const feedback = o.promptFeedback;
    if (isRecord(feedback) && typeof feedback.blockReason === "string") {
      return { error: `the prompt was blocked by the provider (${feedback.blockReason})` };
    }
    const out: WireEvent = {};
    const candidates = o.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const first = candidates[0];
      const content = isRecord(first) ? first.content : undefined;
      const parts = isRecord(content) ? content.parts : undefined;
      if (Array.isArray(parts)) {
        const text = parts
          .map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : ""))
          .join("");
        if (text) out.delta = text;
        // Unlike the other two, Gemini delivers a call WHOLE — name and arguments together,
        // in one part. So the "fragment" is the complete argument JSON, and the call needs a
        // synthetic id: Gemini issues none, and the loop pairs results by id everywhere else.
        // The name is that id, which is also exactly what `functionResponse` pairs on.
        // EVERY functionCall part, not just the first: Gemini delivers a turn's parallel calls
        // as several parts inside one candidate, and taking `findIndex` discarded all but one.
        const parsed: NonNullable<WireEvent["toolCalls"]>[number][] = [];
        for (let k = 0; k < parts.length; k++) {
          const part = parts[k];
          if (!isRecord(part) || !isRecord(part.functionCall)) continue;
          const fc = part.functionCall;
          const name = typeof fc.name === "string" ? fc.name : "";
          parsed.push({
            index: k,
            id: name,
            name,
            argsFragment: JSON.stringify(fc.args ?? {}),
            // Gemini hands over a call WHOLE, and `k` is only its position inside THIS chunk —
            // 0 for every call when the server streams one per chunk. Saying so here is what
            // stops the reader keying two different calls into one accumulator slot.
            complete: true,
          });
        }
        if (parsed.length > 0) {
          out.toolCalls = parsed;
          out.toolCall = parsed[0];
        }
      }
    }
    if (Array.isArray(candidates) && candidates.length > 0) {
      const first = candidates[0];
      const finish = isRecord(first) ? first.finishReason : undefined;
      // STOP is the ordinary end; anything else truncated or refused the answer.
      if (
        typeof finish === "string" &&
        finish &&
        finish !== "STOP" &&
        finish !== "FINISH_REASON_UNSPECIFIED"
      ) {
        out.error = `the model stopped early (${finish})`;
      }
    }
    const meta = o.usageMetadata;
    if (isRecord(meta)) {
      const inTok = num(meta.promptTokenCount);
      const outTok = num(meta.candidatesTokenCount);
      if (inTok !== undefined || outTok !== undefined) {
        const cacheRead = num(meta.cachedContentTokenCount);
        out.usage = {
          inputTokens: inTok ?? 0,
          outputTokens: outTok ?? 0,
          totalTokens: num(meta.totalTokenCount) ?? (inTok ?? 0) + (outTok ?? 0),
          ...(cacheRead !== undefined ? { cacheRead } : {}),
        };
      }
    }
    return out;
  },
};

/* ── selection ─────────────────────────────────────────────────────────────*/

/**
 * The format an endpoint speaks, from the runtime already derived from its base URL.
 *
 * Reusing `runtimeFromBaseUrl` rather than adding a `wireFormat` field to `AiEndpoint` is
 * deliberate: that classifier already distinguishes anthropic/gemini/openai and is already
 * consulted for the reasoning-effort dialect, so a new field would be a second source of the
 * same fact — and the two would eventually disagree.
 *
 * Everything unrecognised gets OpenAI, which is the correct default: it is what all sixteen
 * registered providers and every local runner speak.
 */
export function selectWire(runtime: EffortRuntime): WireFormat {
  if (runtime === "anthropic") return ANTHROPIC_WIRE;
  if (runtime === "gemini") return GEMINI_WIRE;
  return OPENAI_WIRE;
}
