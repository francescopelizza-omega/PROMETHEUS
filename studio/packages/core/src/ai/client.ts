/**
 * ai/client.ts — the provider-agnostic AI client (file 07 §7).
 *
 * Three editor surfaces (Cmd-K inline edit, the agent/chat pane, "generate commit
 * message"), ONE shared client. It is PROVIDER-AGNOSTIC: it talks to whatever
 * endpoint the MODEL HUB (file 05) hands it — a local OpenAI-compatible URL
 * (vLLM/llama.cpp/Ollama) or a cloud provider — selected per-session. It streams
 * an OpenAI-compatible `/v1/chat/completions` SSE response (parse `data:` lines,
 * stop on `[DONE]`).
 *
 * It is a THIN client (file 07 §0/§7.5): NO weights, NO serving, NO security
 * logic. Endpoints are INPUT (from the Model Hub); the api key is a KEYCHAIN REF
 * (never the raw key in JS state); and a per-workspace "never send to cloud"
 * policy guard REFUSES a cloud endpoint BEFORE any request leaves the machine.
 *
 * Node built-ins only: it uses the global `fetch` (Node 18+/Electron) — injectable
 * for tests so the cloud-policy guard + SSE parsing are testable against a LOCAL
 * node:http stub (no real model), per the env limits.
 */

import { estimateTextTokens } from "../agent/compact.js";
import { IdleWatchdog } from "../agent/idle-watchdog.js";
import { applyEffort, applyEffortToMessages } from "./effort/apply.js";
import { runtimeFromBaseUrl } from "./effort/rules.js";
import type { EffortResolution } from "./effort/types.js";
import { localKeepAliveField } from "./local-runners.js";
import { applyPromptCache, cacheDialectFor } from "./prompt-cache.js";
import { endpointBreaker, fetchModelWithRetry } from "./request.js";
import { ContextOverflowError, preflightContext, replyReserveFor } from "./retry-policy.js";
import { emptyTurnNotice, truncationNotice } from "./turn-outcome.js";
import { mergeWireUsage } from "./usage.js";
import { type WireEvent, selectWire } from "./wire.js";

/* ------------------------------------------------------------------------- *
 * Endpoint, policy, and message types (file 07 §7)
 * ------------------------------------------------------------------------- */

/** Whether an endpoint serves a LOCAL model or a CLOUD provider (privacy axis). */
export type EndpointLocality = "local" | "cloud";

/** A model endpoint surfaced by the Model Hub (file 05). */
export interface AiEndpoint {
  /** 'local:qwen2.5-coder-7b@vllm' | 'cloud:anthropic:claude-…'. */
  id: string;
  /** the served URL — local serve URL or provider base URL (from file 05). */
  baseUrl: string;
  /** local (free, offline, private) vs cloud — gates the privacy policy (§7.5). */
  locality: EndpointLocality;
  /** keychain REF, never the raw key in JS state (§7). */
  apiKeyRef?: string;
  contextWindow: number;
  /** gates whether the agent pane can use this model (tool calls). */
  supportsTools: boolean;
  /** the model name to send in the request body (defaults to a sane id). */
  model?: string;
  /**
   * Ollama `/api/show`'s `capabilities` array (e.g. `["completion","tools","thinking"]`),
   * filled in by the SAME context-window probe that measures `contextWindow` — `undefined`
   * until that probe resolves (or for any non-Ollama/cloud endpoint). This is what lets
   * `ai/effort/rules.ts`'s probe-driven rules (`ollama-native-thinking`, etc.) actually match
   * instead of falling through to `UNKNOWN_CAPABILITY` for every model, always.
   */
  probedCapabilities?: readonly string[];
}

/** Per-workspace privacy policy (file 07 §7.5). */
export interface WorkspacePolicy {
  /** "never send this repo's code to cloud" → greys/refuses cloud endpoints. */
  neverSendToCloud: boolean;
}

/** A chat message in the OpenAI shape. */
export interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** Chat streaming options. */
export interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
  /** abort the in-flight stream (forwarded to fetch). */
  signal?: AbortSignal;
  /**
   * A RESOLVED reasoning-effort decision (ai/effort). Already translated to this backend's
   * dialect by `resolveEffort`, so the transport only applies it — it never guesses a
   * parameter name. Omitted, or resolved to `applied: null`, ⇒ nothing is added to the body,
   * which is what keeps a knobless model from taking a 400.
   */
  effort?: EffortResolution;
  /**
   * Ask the provider to cache the stable prefix of this conversation.
   *
   * Defaults ON where it costs nothing to request and is a no-op where the provider has no
   * request side. See `ai/prompt-cache.ts` for why one boolean cannot mean the same thing to
   * OpenAI, Anthropic and Gemini.
   */
  promptCache?: boolean;
  /**
   * Append a one-line explanation when the turn produced NO text (default true).
   *
   * Off for a caller that has its own empty-turn handling — the CLI's tool transports answer an
   * empty turn by correcting the model rather than by telling the user. The TRUNCATION notice
   * (a real answer, cut short) is never suppressed: nothing else reports it.
   */
  emptyTurnNotice?: boolean;
  /**
   * This request's inactivity-pause threshold — see `agent/idle-watchdog.ts`. Undefined ⇒
   * `DEFAULT_IDLE_TIMEOUT_MS` (10 minutes).
   *
   * Previously ONLY the CLI's native tool-calling transport (`toolTurn` in
   * apps/cli/session/agent-runtime.ts) had this protection; this shared `stream()` — the text/
   * no-tools transport EVERY caller falls back to, and the ONLY transport the VS Code
   * extension and `makeSummarizer`'s background call ever use — had none, so a cold-loading
   * or wedged local model hung those callers exactly as the CLI hung before root-cause #1's
   * fix, just on a different code path.
   */
  idleTimeoutMs?: number;
  /** test-only clock injection for the idle watchdog, mirroring the same seam already exposed
   *  on the CLI's `toolTurn`/`LlmClientDeps` for exactly the same reason (a 30s-floor watchdog
   *  cannot be exercised with a fast real-timer test). Production never sets these. */
  idleWatchdogNow?: () => number;
  idleWatchdogSetTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  idleWatchdogClearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** A streamed chat delta. */
export interface ChatChunk {
  /** the incremental text token(s). */
  delta: string;
  /** set on the final chunk. */
  done?: boolean;
  /** OpenAI-compatible token usage (CLI-029) — present ONLY on the terminal chunk when the
   * server emitted a `usage` frame (`stream_options.include_usage`); undefined otherwise. */
  usage?: SseTokenUsage;
}

/** A Cmd-K inline edit request (file 07 §7.1). */
export interface InlineEditReq {
  /** the user instruction ("add retry with backoff"). */
  instruction: string;
  /** the selected text (or current line/block) to transform. */
  selection: string;
  /** a window of surrounding context the prompt includes. */
  context?: string;
  /** the file's language id (so the model knows the syntax). */
  languageId?: string;
  signal?: AbortSignal;
}

/** A streamed edit delta — the proposed replacement, streamed token-by-token. */
export interface EditChunk {
  delta: string;
  done?: boolean;
}

/* ------------------------------------------------------------------------- *
 * The fetch seam (injectable so tests use a local stub, not a real model)
 * ------------------------------------------------------------------------- */

/** The subset of `fetch` the client needs (response must expose a byte stream). */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  /**
   * The response headers, so `Retry-After` can be honoured.
   *
   * OPTIONAL because this seam predates the retry path and several test stubs implement the
   * response by hand; a stub without headers simply yields no advice and the backoff curve
   * stands. Making it required would break those stubs to gain nothing.
   */
  headers?: { get(name: string): string | null };
}>;

/** Resolve a keychain ref → the raw key. Injected; default refuses (no keychain). */
export type KeyResolver = (apiKeyRef: string) => Promise<string>;

/** Construction deps (all injectable for tests; defaults use the global fetch). */
export interface AiClientDeps {
  fetch?: FetchLike;
  resolveKey?: KeyResolver;
  /** injected sleeper so the backoff schedule is testable without real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** injected RNG in [0,1) for jitter — tests pin it. */
  rng?: () => number;
  /**
   * Fired before each retry, so a host can SAY it is retrying.
   *
   * A silent retry is nearly as bad as no retry: the user sees a turn that takes six seconds
   * with no explanation, and has no way to know the provider rate-limited them.
   */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /**
   * Fired once a request to a LOCAL endpoint (`endpoint.locality === "local"`) actually
   * succeeds — never for a cloud endpoint. Feeds the idle-shutdown watchdog's "last used"
   * timestamp; a caller with no local-runner lifecycle to manage (most tests) can omit it.
   */
  onLocalActivity?: () => void;
}

/* ------------------------------------------------------------------------- *
 * The error a cloud-policy refusal raises (caught & surfaced, never leaks a req)
 * ------------------------------------------------------------------------- */

/** Thrown BEFORE any network request when the workspace policy forbids cloud. */
export class CloudPolicyError extends Error {
  readonly endpointId: string;
  constructor(endpointId: string) {
    super(
      `cloud endpoint "${endpointId}" refused: this workspace has "never send to cloud" enabled`,
    );
    this.name = "CloudPolicyError";
    this.endpointId = endpointId;
  }
}

/**
 * Thrown by `stream()` when its OWN idle watchdog — not the caller's `signal` — aborted the
 * fetch/read because the endpoint went silent for `idleTimeoutMs`. Distinguishing this from a
 * generic abort/network failure is the whole point: a caller catching this converts a would-be
 * hard failure into a graceful pause (no work discarded, resumable), exactly as
 * `apps/cli/session/agent-runtime.ts`'s native `toolTurn` already does for its own transport.
 */
/**
 * A provider reported a fault MID-STREAM, after the HTTP 200.
 *
 * Anthropic sends `{"type":"error","error":{…}}` on overload or a mid-generation fault,
 * OpenAI-compatible servers send a bare `{"error":{…}}` frame, and Gemini reports a blocked
 * prompt via `promptFeedback.blockReason`. `wire.ts` parses all three into `WireEvent.error` —
 * and the stream loop below used to read only `delta`/`usage`/`done`, so every one of them was
 * dropped on the floor. The turn ended normally with a truncated or completely empty answer and
 * the user was told nothing at all. Reproduced against a real HTTP server: an `overloaded_error`
 * after a text delta yielded `""` and threw nothing.
 */
export class ProviderStreamError extends Error {
  readonly endpointId: string;
  /** whatever text had already been streamed before the fault, so a host can still show it. */
  readonly partial: string;
  constructor(endpointId: string, message: string, partial: string) {
    super(`${endpointId}: ${message}`);
    this.name = "ProviderStreamError";
    this.endpointId = endpointId;
    this.partial = partial;
  }
}

export class ModelIdlePausedError extends Error {
  readonly idleMs: number;
  constructor(idleMs: number) {
    super(`model went silent for ${Math.round(idleMs / 1000)}s`);
    this.name = "ModelIdlePausedError";
    this.idleMs = idleMs;
  }
}

/* ------------------------------------------------------------------------- *
 * SSE parsing — OpenAI-compatible /v1/chat/completions stream (pure)
 * ------------------------------------------------------------------------- */

/**
 * Parse a buffer of SSE text into completed `data:` payloads, retaining the
 * partial tail. Each SSE event is `data: <json>\n` (sometimes split mid-frame
 * across chunks). Returns the JSON payload strings (without the `data: ` prefix)
 * plus the leftover buffer. The literal `[DONE]` is returned as a payload so the
 * caller can stop. Pure — the streaming loop owns the bytes.
 */
export function parseSseChunk(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  let nl = rest.indexOf("\n");
  while (nl !== -1) {
    const line = rest.slice(0, nl).replace(/\r$/, "");
    rest = rest.slice(nl + 1);
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      payloads.push(trimmed.slice("data:".length).trim());
    }
    // blank lines / comment (`:`) lines / other event fields are ignored.
    nl = rest.indexOf("\n");
  }
  return { payloads, rest };
}

/** Extract the streamed `delta.content` from one OpenAI chunk JSON payload. */
export function deltaFromPayload(payload: string): string {
  if (payload === "[DONE]") return "";
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return "";
  }
  const choices = (obj as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as { delta?: { content?: unknown }; text?: unknown };
  // chat-completions: choices[].delta.content ; legacy completions: choices[].text
  const content = first.delta?.content;
  if (typeof content === "string") return content;
  if (typeof first.text === "string") return first.text;
  return "";
}

/** Token usage for one call (mirrors ai.guardrails TokenUsage; input/output/total). */
export interface SseTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * Prompt-cache tokens (CLI-090), normalized across providers into one shape. OPTIONAL and
   * `undefined` when the provider's usage payload carried NO cache field at all — that is
   * "unmeasurable here", which the report must render as "not available for this provider"
   * rather than a `0` that reads as "caching isn't helping". A present `0` means measured-but-no-hit.
   *   Anthropic: cache_read_input_tokens / cache_creation_input_tokens
   *   OpenAI:    prompt_tokens_details.cached_tokens (read only; no create field)
   *   Gemini:    cachedContentTokenCount (read only)
   */
  cacheRead?: number;
  cacheCreate?: number;
}

/** A finite non-negative number or undefined (fail-soft: NaN/Infinity/negative/non-number → undefined). */
function finiteNonNeg(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
}

/**
 * Pull the normalized prompt-cache counters out of one provider's `usage` object (CLI-090).
 * Returns `{}` (both undefined) when NO known cache field is present — the caller keeps them
 * undefined so the report can say "not available for this provider" instead of a misleading 0.
 */
function cacheTokensFromUsage(u: Record<string, unknown>): {
  cacheRead?: number;
  cacheCreate?: number;
} {
  // Anthropic — flat fields on usage.
  const anthRead = finiteNonNeg(u.cache_read_input_tokens);
  const anthCreate = finiteNonNeg(u.cache_creation_input_tokens);
  // OpenAI — nested under prompt_tokens_details.cached_tokens (read only).
  const details = u.prompt_tokens_details;
  const openaiRead = isRecord(details) ? finiteNonNeg(details.cached_tokens) : undefined;
  // Gemini — cachedContentTokenCount (read only; some gateways fold it onto usage).
  const geminiRead = finiteNonNeg(u.cachedContentTokenCount);
  const cacheRead = anthRead ?? openaiRead ?? geminiRead;
  const cacheCreate = anthCreate;
  return {
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheCreate !== undefined ? { cacheCreate } : {}),
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/**
 * Extract an OpenAI-compatible `usage` object from one SSE payload → SseTokenUsage, or
 * null (APP-055). Kept IDENTICAL to the renderer's ai-client.ts usageFromPayload: handles
 * the final `include_usage` chunk (empty choices + usage) and usage folded into the last
 * content chunk; skips `[DONE]`; fail-soft on malformed usage. Also normalizes the
 * per-provider prompt-cache counters (CLI-090) — absent field ⇒ undefined (never 0).
 */
export function usageFromPayload(payload: string): SseTokenUsage | null {
  if (payload === "[DONE]") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  /**
   * Gemini reports usage under `usageMetadata` with NO `usage` key at all.
   *
   * This function gated on `usage.prompt_tokens` / `usage.completion_tokens` and returned null
   * for anything else, despite its own docstring saying it normalizes the per-provider counters.
   * The CLI's native tool transport uses it as its ONLY usage source — and native is the
   * transport Claude and Gemini both take, since both wires report supportsTools:true — so every
   * agentic Claude/Gemini turn fell through to a chars/4 estimate flagged `estimated: true`,
   * and never recorded the cache counters at all.
   */
  const meta = (obj as { usageMetadata?: unknown }).usageMetadata;
  if (isRecord(meta)) {
    const inTok = finiteNonNeg(meta.promptTokenCount);
    const outTok = finiteNonNeg(meta.candidatesTokenCount);
    if (inTok !== undefined || outTok !== undefined) {
      const inputTokens = inTok ?? 0;
      const outputTokens = outTok ?? 0;
      const cacheRead = finiteNonNeg(meta.cachedContentTokenCount);
      return {
        inputTokens,
        outputTokens,
        totalTokens: finiteNonNeg(meta.totalTokenCount) ?? inputTokens + outputTokens,
        ...(cacheRead !== undefined ? { cacheRead } : {}),
      };
    }
  }

  /**
   * Anthropic splits usage over two frames: `message_start` nests it under `message.usage` and
   * carries input_tokens + the cache counters; `message_delta` puts `usage` at the top level
   * with output_tokens only. Both are surfaced here — `mergeWireUsage` is what recombines them.
   */
  const top = (obj as { usage?: unknown }).usage;
  const nested = isRecord((obj as { message?: unknown }).message)
    ? ((obj as { message: Record<string, unknown> }).message.usage as unknown)
    : undefined;
  const u = (isRecord(top) ? top : isRecord(nested) ? nested : undefined) as
    | Record<string, unknown>
    | undefined;
  if (!u) return null;

  // OpenAI names first, then Anthropic's — a frame carries one vocabulary or the other.
  const inTok = finiteNonNeg(u.prompt_tokens) ?? finiteNonNeg(u.input_tokens);
  const outTok = finiteNonNeg(u.completion_tokens) ?? finiteNonNeg(u.output_tokens);
  const cache = cacheTokensFromUsage(u);
  // a payload with ONLY cache fields (no prompt/completion) is not a usage frame we accumulate.
  if (inTok === undefined && outTok === undefined) return null;
  const inputTokens = inTok ?? 0;
  const outputTokens = outTok ?? 0;
  const totalTokens = finiteNonNeg(u.total_tokens) ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens, ...cache };
}

/* ------------------------------------------------------------------------- *
 * The client
 * ------------------------------------------------------------------------- */

const SYSTEM_EDIT_PROMPT =
  "You are a code-editing assistant. Rewrite ONLY the selected code per the " +
  "instruction. Return the replacement code with no commentary, no fences.";

/** The provider-agnostic AI client (file 07 §7). */
export interface AiClient {
  chat(messages: Msg[], opts?: ChatOpts): AsyncIterable<ChatChunk>;
  edit(req: InlineEditReq): AsyncIterable<EditChunk>;
}

/**
 * Create an AI client bound to one endpoint + workspace policy. The endpoint and
 * policy come from the Model Hub / per-workspace settings (file 05/§7.5). The
 * client streams an OpenAI-compatible SSE response and enforces the cloud policy
 * BEFORE any request leaves the machine.
 */
export function createAiClient(
  endpoint: AiEndpoint,
  policy: WorkspacePolicy,
  deps: AiClientDeps = {},
): AiClient {
  const doFetch: FetchLike =
    deps.fetch ??
    ((globalThis as { fetch?: unknown }).fetch as FetchLike | undefined) ??
    (() => {
      throw new Error("no fetch available; inject deps.fetch");
    });
  const resolveKey: KeyResolver =
    deps.resolveKey ??
    (async (ref) => {
      throw new Error(`no key resolver; cannot resolve apiKeyRef "${ref}"`);
    });

  /**
   * The protocol this endpoint speaks, chosen from the runtime its base URL implies.
   *
   * Everything unrecognised gets OpenAI, which is the correct default: all sixteen registered
   * providers and every local runner speak it.
   */
  const wire = selectWire(runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality));

  /** Enforce the per-workspace cloud policy — throws BEFORE any request leaves. */
  function enforcePolicy(): void {
    if (policy.neverSendToCloud && endpoint.locality === "cloud") {
      throw new CloudPolicyError(endpoint.id);
    }
  }

  /**
   * Build the request headers, resolving the keychain ref at request time.
   *
   * The FORMAT decides the credential header, not this function: a bearer token is an OpenAI
   * convention, and sending one to Anthropic (which wants `x-api-key`) or Gemini (which wants
   * `x-goog-api-key`) is a 401 no amount of retrying fixes.
   */
  async function buildHeaders(): Promise<Record<string, string>> {
    const key = endpoint.apiKeyRef ? await resolveKey(endpoint.apiKeyRef) : "";
    return { "content-type": "application/json", ...wire.headers(key) };
  }

  /** POST the chat-completions request and yield streamed text deltas; usage → onUsage. */
  async function* stream(
    messages: Msg[],
    opts: ChatOpts,
    onUsage?: (u: SseTokenUsage) => void,
    // WHY the model stopped, when the provider says so. "length" = the reply was cut off;
    // without it a truncated answer (or an answer truncated to NOTHING) is pure silence.
    onStop?: (r: NonNullable<WireEvent["stopReason"]>) => void,
  ): AsyncGenerator<string, void, unknown> {
    // C5/privacy: refuse a cloud endpoint up-front; nothing has left the machine.
    enforcePolicy();
    const headers = await buildHeaders();
    // Tolerate a baseUrl that ALREADY ends in /v1 (the engine's `localai endpoints` returns
    // e.g. "http://localhost:11434/v1") — plain joinUrl would emit ".../v1/v1/chat/completions"
    // → the runner answers "404 page not found" and chat is dead. Dedupe the /v1 segment.
    const url = wire.url(endpoint.baseUrl, endpoint.model ?? endpoint.id);
    // A prompt-shaped effort knob (gpt-oss's `Reasoning: high`) rewrites the messages; a
    // body-shaped one adds a field. `applyEffort` also enforces the side-constraints that
    // would otherwise 400 — dropping temperature where the model rejects it, raising a
    // max_tokens floor where reasoning and answer must share the budget.
    const effMessages = applyEffortToMessages(messages, opts.effort);
    /**
     * Actually ASK for the prompt cache this repo already measures.
     *
     * `usageFromPayload` has normalized three providers' cache counters from the start and
     * `prometheus tokens report` prices the savings — but nothing ever requested caching, and
     * `cache_control` appeared nowhere in the repo. On OpenAI-shaped endpoints this is a no-op
     * by design (they cache automatically and offer no request field), so the marked-block form
     * is emitted ONLY where it is understood.
     */
    const runtime = runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality);
    const cacheMessages =
      opts.promptCache === false
        ? effMessages
        : applyPromptCache(effMessages, cacheDialectFor(runtime));
    /**
     * The body, built by the selected FORMAT.
     *
     * Anthropic lifts the system prompt to a top-level field and requires `max_tokens`; Gemini
     * renames the assistant role and wraps text in `parts[]`. Sending the OpenAI shape to
     * either is a 400 at best — and against `api.anthropic.com` the URL itself 404s, because
     * `/v1/chat/completions` does not exist there.
     *
     * `applyEffort` still runs last, so a reasoning knob is not undone by a field written
     * above it. It is a no-op on a body whose fields it does not recognise.
     */
    const body = JSON.stringify(
      applyEffort(
        {
          ...wire.body(cacheMessages as never, {
            model: endpoint.model ?? endpoint.id,
            // Ask for a terminal usage frame, CLOUD ONLY. A strict local server (llama.cpp
            // builds, older proxies) 400s on the unknown field, and a 400 here does not
            // degrade to a missing token count — it kills the turn. Local tokens are free, so
            // the estimate fallback costs nothing there.
            includeUsage: endpoint.locality === "cloud",
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
          }),
          // Ollama extension, ignored elsewhere: keep the model resident so a multi-round
          // agentic turn does not pay a cold reload between rounds. LOCAL only — a cloud
          // endpoint never receives a non-standard field.
          ...localKeepAliveField(endpoint.locality),
        },
        opts.effort,
      ),
    );

    /**
     * Refuse an impossible request HERE, with a sentence, rather than paying for a 400.
     *
     * Estimated from the characters we are about to send — the same `chars/4` compaction
     * budgets with — and deliberately generous (see PREFLIGHT_MARGIN), so this only catches the
     * clearly-impossible. Anything borderline still goes to the endpoint, which is the
     * authority on its own tokenizer.
     */
    const pre = preflightContext({
      estimatedPromptTokens: estimateTextTokens(effMessages.map((m) => m.content)),
      contextWindow: endpoint.contextWindow,
      // A reply needs room too. With no `maxTokens` the reserve was 0, so "it fits" stayed true
      // until the last token of the window and the answer had nowhere to go.
      maxTokens: replyReserveFor(endpoint.contextWindow, opts.maxTokens),
    });
    if (!pre.ok) throw new ContextOverflowError(pre, endpoint.contextWindow);

    /**
     * Our own controller so an IDLE PAUSE (or the caller's `opts.signal`) cancels the fetch +
     * reader — RE-ARMED per attempt, mirroring `apps/cli/session/agent-runtime.ts`'s native
     * `toolTurn` exactly (see its own comment on the same pattern). Before this, `opts.signal`
     * was handed to `fetchModelWithRetry` directly as BOTH `signalFor` and `userSignal`, which
     * gave the caller's own abort a way in but gave this transport no timer of its own — a
     * cold-loading or wedged model hung here FOREVER, on the only transport the VS Code
     * extension and `makeSummarizer`'s background call ever use.
     */
    let ac = new AbortController();
    /**
     * STABLE across every retry attempt (never reassigned) — this is what the idle watchdog
     * actually aborts, and what is threaded into `fetchModelWithRetry` below as `userSignal` so
     * `retry()`'s own abort checks (before each attempt, and right after a failed one,
     * `resilience/retry.ts:80,86`) see it regardless of whether a fetch is live or the loop is
     * in its backoff SLEEP between attempts.
     *
     * Without this (verification pass #2's CRITICAL finding): `onIdle` used to abort the
     * per-attempt `ac` directly, which is reassigned fresh on every `armAttempt()` call — an
     * idle-fire landing during the backoff sleep (nothing pending on `ac` at that instant, the
     * previous attempt already settled and the next hasn't started) aborted a controller nothing
     * was listening to, was silently lost, and — because `IdleWatchdog` is a documented ONE-SHOT
     * (`fired` latches true forever) — could never fire again for the rest of this call, so a
     * genuine later stall in the same request hung forever instead of pausing.
     */
    const outerAc = new AbortController();
    const onUserAbort = (): void => outerAc.abort();
    if (opts.signal) {
      if (opts.signal.aborted) outerAc.abort();
      else opts.signal.addEventListener("abort", onUserAbort, { once: true });
    }
    // propagate immediately to whichever per-attempt controller is CURRENTLY live, so an active
    // fetch/read is torn down right away rather than only on the NEXT attempt noticing.
    outerAc.signal.addEventListener("abort", () => ac.abort(), { once: true });
    const watchdog = new IdleWatchdog({
      idleTimeoutMs: opts.idleTimeoutMs,
      onIdle: () => outerAc.abort(),
      ...(opts.idleWatchdogNow ? { now: opts.idleWatchdogNow } : {}),
      ...(opts.idleWatchdogSetTimeout ? { setTimeoutFn: opts.idleWatchdogSetTimeout } : {}),
      ...(opts.idleWatchdogClearTimeout ? { clearTimeoutFn: opts.idleWatchdogClearTimeout } : {}),
    });
    watchdog.arm();
    const armAttempt = (): AbortSignal => {
      ac = new AbortController();
      // an idle-fire/cancel that landed during the backoff sleep (before this attempt even
      // started) must still stop it from firing its own fetch.
      if (outerAc.signal.aborted) ac.abort();
      return ac.signal;
    };
    /**
     * Interrupt the backoff sleep itself the INSTANT `outerAc` aborts, rather than letting the
     * full delay elapse before `retry()`'s next top-of-loop check ever notices — the difference
     * between an idle-pause registering immediately and one registering up to `maxMs`/a
     * provider's `Retry-After` (capped at `adviceCapMs`) late. Scoped entirely to this call: the
     * shared `resilience/retry.ts` primitive itself is untouched.
     */
    const abortableSleep = (ms: number): Promise<void> =>
      deps.sleep
        ? deps.sleep(ms)
        : new Promise((resolve) => {
            if (outerAc.signal.aborted) {
              resolve();
              return;
            }
            const t = setTimeout(resolve, ms);
            outerAc.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
    /** Did OUR watchdog (not the caller's `opts.signal`) cause this abort? */
    const idlePaused = (): boolean =>
      outerAc.signal.aborted && !opts.signal?.aborted && watchdog.didFire();

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      /**
       * The request, with bounded retries — and the retry stops HERE, before a single token has
       * been yielded.
       *
       * That boundary is the whole design. Everything below is a stream the consumer is already
       * reading; retrying after a delta has been emitted would replay text the user has seen,
       * which is worse than the failure. `fetchModelWithRetry` is shared with the other three
       * transports so this judgement is made in one place.
       */
      let res: Awaited<ReturnType<typeof doFetch>>;
      try {
        res = await fetchModelWithRetry({
          endpointId: endpoint.id,
          url,
          init: { method: "POST", headers, body },
          doFetch,
          // Fail fast on a dead endpoint (unreachable local runner, sidecar down) instead of
          // paying the full retry schedule on every round of every turn — see `endpointBreaker`.
          breaker: endpointBreaker(endpoint.id),
          signalFor: armAttempt,
          // ALWAYS `outerAc.signal`, not just when the caller passed one: this is what makes an
          // idle-fire landing during the backoff sleep observable to `retry()`'s own checks —
          // `opts.signal`'s abort already propagates into it via the listener above.
          userSignal: outerAc.signal,
          // …but only the CALLER's signal means "the human stopped it". An idle-watchdog
          // abort reaches `outerAc` too and must still count against the endpoint.
          userAborted: () => opts.signal?.aborted === true,
          sleep: abortableSleep,
          ...(deps.rng ? { rng: deps.rng } : {}),
          onRetry: (info) => {
            watchdog.touch(); // a response — even a failing one — is evidence of life.
            deps.onRetry?.(info);
          },
          ...(endpoint.locality === "local" && deps.onLocalActivity
            ? { onLocalActivity: deps.onLocalActivity }
            : {}),
        });
      } catch (err) {
        if (idlePaused()) throw new ModelIdlePausedError(watchdog.idleForMs());
        throw err;
      }
      if (!res.body) throw new Error(`AI endpoint ${endpoint.id}: empty response body`);

      /**
       * A 200 that is NOT an SSE stream is still an answer.
       *
       * Plenty of OpenAI-compatible servers, proxies and gateways ignore `stream: true` and
       * reply with an ordinary JSON completion. The reader below looks only for `data:` lines,
       * found none, and the turn ended with no text, no usage and no error — a completely silent
       * answer, indistinguishable to the user from the model declining to reply. Reproduced
       * against a real HTTP server: `text: ""`, `threw: NOTHING`.
       *
       * The content-type is the signal, and it is read BEFORE any of the stream machinery so a
       * non-streaming server takes a short, obvious path rather than falling through the SSE
       * parser and yielding nothing.
       */
      const contentType = res.headers?.get?.("content-type") ?? "";
      if (contentType && !/text\/event-stream/i.test(contentType)) {
        const whole = await res.text();
        const ev = wire.parseWhole(whole);
        if (ev.error !== undefined) throw new ProviderStreamError(endpoint.id, ev.error, "");
        if (ev.usage && onUsage) onUsage(ev.usage);
        if (ev.delta) {
          yield ev.delta;
          return;
        }
        // A body we could not read at all is a failure, not silence.
        throw new ProviderStreamError(
          endpoint.id,
          `the endpoint answered 200 with ${contentType || "an unknown content type"} and no readable content`,
          "",
        );
      }

      const decoder = new TextDecoder();
      let buf = "";
      /** Text already handed to the caller — carried on a mid-stream fault so it is not lost. */
      let streamed = "";
      reader = res.body.getReader();
      for (;;) {
        let value: Uint8Array | undefined;
        let done: boolean;
        try {
          ({ value, done } = await reader.read());
        } catch (err) {
          if (idlePaused()) throw new ModelIdlePausedError(watchdog.idleForMs());
          throw err;
        }
        if (done) break;
        watchdog.touch(); // REAL evidence of life — resets the idle countdown.
        buf += decoder.decode(value, { stream: true });
        const { payloads, rest } = parseSseChunk(buf);
        buf = rest;
        for (const p of payloads) {
          // The FORMAT says what the bytes mean: OpenAI ends on `[DONE]`, Anthropic on a
          // `message_stop` event, and each puts its text and its usage somewhere different.
          const ev = wire.parse(p);
          // A fault AFTER the 200 is still a failed turn. Reported, never swallowed — see
          // `ProviderStreamError`. Usage that arrived on the same frame is banked first so a
          // failed turn is still billed for what it actually consumed.
          if (ev.error !== undefined) {
            if (ev.usage && onUsage) onUsage(ev.usage);
            throw new ProviderStreamError(endpoint.id, ev.error, streamed);
          }
          if (ev.stopReason && onStop) onStop(ev.stopReason);
          if (ev.done) return;
          if (ev.usage && onUsage) onUsage(ev.usage);
          if (ev.delta) {
            streamed += ev.delta;
            yield ev.delta;
          }
        }
      }
      // flush any trailing buffered frame (server closed without a final newline).
      const { payloads } = parseSseChunk(`${buf}\n`);
      for (const p of payloads) {
        const ev = wire.parse(p);
        if (ev.error !== undefined) {
          if (ev.usage && onUsage) onUsage(ev.usage);
          throw new ProviderStreamError(endpoint.id, ev.error, streamed);
        }
        if (ev.stopReason && onStop) onStop(ev.stopReason);
        if (ev.done) return;
        if (ev.usage && onUsage) onUsage(ev.usage);
        if (ev.delta) {
          streamed += ev.delta;
          yield ev.delta;
        }
      }

      /**
       * LAST RESORT: the stream produced nothing, but the body is a complete non-streamed
       * completion.
       *
       * The fast path above only takes the whole-body route when a content-type is PRESENT and
       * is not `text/event-stream` (`contentType && !…`). A 200 that carries a full JSON
       * completion and NO content-type header at all therefore fell straight through to the SSE
       * reader, which found no `data:` frames and yielded nothing — a silent empty answer, no
       * error, indistinguishable from the model declining to reply. Measured against a raw
       * `node:net` server so the header could genuinely be absent: header present →
       * "the real answer"; header absent → "", nothing thrown.
       *
       * Recovering HERE rather than by loosening that conjunct keeps a server that streams real
       * SSE without declaring a content-type working exactly as before — this runs only when the
       * stream yielded no text at all — and it also rescues a MISLABELLED content-type, which
       * the conjunct never would. The per-frame handling is not duplicated a third time; only
       * the whole-body parse is reused.
       */
      if (streamed === "" && buf.trim() !== "") {
        const ev = wire.parseWhole(buf);
        if (ev.error !== undefined) throw new ProviderStreamError(endpoint.id, ev.error, "");
        if (ev.usage && onUsage) onUsage(ev.usage);
        if (ev.delta) {
          yield ev.delta;
          return;
        }
        // Read it, understood none of it — a failure, not silence (same rule as the fast path).
        throw new ProviderStreamError(
          endpoint.id,
          `the endpoint answered 200 with ${contentType || "no content type"} and no readable content`,
          "",
        );
      }
    } finally {
      watchdog.dispose();
      if (opts.signal) opts.signal.removeEventListener("abort", onUserAbort);
      // Runs on EVERY exit — normal end, `return` on [DONE], an idle pause, a real error, AND a
      // consumer breaking the for-await early (which invokes the generator's .return()) —
      // releasing the lock + closing the response body/socket so nothing leaks or keeps
      // streaming.
      await reader?.cancel().catch(() => {});
    }
  }

  return {
    async *chat(messages: Msg[], opts: ChatOpts = {}): AsyncIterable<ChatChunk> {
      let usage: SseTokenUsage | undefined;
      let stopReason: NonNullable<WireEvent["stopReason"]> | undefined;
      let text = "";
      for await (const delta of stream(
        messages,
        opts,
        (u) => {
          usage = mergeWireUsage(usage, u);
        },
        (r) => {
          stopReason = r;
        },
      )) {
        text += delta;
        yield { delta };
      }
      /**
       * A turn that produced NOTHING, or was cut off mid-answer, says so.
       *
       * Every surface on this transport (Studio's pane, the VS Code sidebar) skips an empty
       * reply, so a model that spent its whole remaining window on reasoning ended the turn with
       * nothing on screen at all and no way to tell that from "the model had nothing to say".
       */
      const notice =
        text.trim() === ""
          ? opts.emptyTurnNotice === false
            ? ""
            : emptyTurnNotice({
                ...(stopReason ? { stopReason } : {}),
                promptTokens: estimateTextTokens(messages.map((m) => m.content)),
                contextWindow: endpoint.contextWindow,
                runtime: runtimeFromBaseUrl(endpoint.baseUrl),
              })
          : stopReason === "length"
            ? `\n\n${truncationNotice({
                stopReason,
                promptTokens: estimateTextTokens(messages.map((m) => m.content)),
                contextWindow: endpoint.contextWindow,
                runtime: runtimeFromBaseUrl(endpoint.baseUrl),
              })}`
            : "";
      if (notice) {
        text += notice;
        yield { delta: notice };
      }
      yield { delta: "", done: true, ...(usage ? { usage } : {}) };
    },

    async *edit(req: InlineEditReq): AsyncIterable<EditChunk> {
      const user = [
        req.context ? `Context:\n${req.context}\n` : "",
        `Language: ${req.languageId ?? "plaintext"}`,
        `Instruction: ${req.instruction}`,
        `Selected code:\n${req.selection}`,
      ]
        .filter(Boolean)
        .join("\n");
      const messages: Msg[] = [
        { role: "system", content: SYSTEM_EDIT_PROMPT },
        { role: "user", content: user },
      ];
      const opts: ChatOpts = req.signal ? { signal: req.signal } : {};
      for await (const delta of stream(messages, opts)) {
        yield { delta };
      }
      yield { delta: "", done: true };
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Small pure helpers
 * ------------------------------------------------------------------------- */

/** Join a base URL + path without doubling or dropping the slash. */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/** Read an error body defensively (never throws — used only for error detail). */
async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}

/**
 * Decide whether an endpoint is SELECTABLE under a workspace policy (for the
 * model picker greying — §7.5). Pure; the actual refusal happens in the client.
 */
export function endpointAllowed(endpoint: AiEndpoint, policy: WorkspacePolicy): boolean {
  return !(policy.neverSendToCloud && endpoint.locality === "cloud");
}
