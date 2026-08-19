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
import { applyEffort, applyEffortToMessages } from "./effort/apply.js";
import { runtimeFromBaseUrl } from "./effort/rules.js";
import type { EffortResolution } from "./effort/types.js";
import { applyPromptCache, cacheDialectFor } from "./prompt-cache.js";
import { endpointBreaker, fetchModelWithRetry } from "./request.js";
import { ContextOverflowError, preflightContext } from "./retry-policy.js";
import { selectWire } from "./wire.js";

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
  const u = (obj as { usage?: unknown }).usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== "object") return null;
  const inTok = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
  const outTok = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
  const cache = cacheTokensFromUsage(u);
  // a payload with ONLY cache fields (no prompt/completion) is not a usage frame we accumulate.
  if (inTok === undefined && outTok === undefined) return null;
  const inputTokens = inTok ?? 0;
  const outputTokens = outTok ?? 0;
  const totalTokens =
    typeof u.total_tokens === "number" ? u.total_tokens : inputTokens + outputTokens;
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
          ...(endpoint.locality === "local" ? { keep_alive: "30m" } : {}),
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
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });
    if (!pre.ok) throw new ContextOverflowError(pre, endpoint.contextWindow);

    /**
     * The request, with bounded retries — and the retry stops HERE, before a single token has
     * been yielded.
     *
     * That boundary is the whole design. Everything below is a stream the consumer is already
     * reading; retrying after a delta has been emitted would replay text the user has seen,
     * which is worse than the failure. `fetchModelWithRetry` is shared with the other three
     * transports so this judgement is made in one place.
     */
    const res = await fetchModelWithRetry({
      endpointId: endpoint.id,
      url,
      init: { method: "POST", headers, body },
      doFetch,
      // Fail fast on a dead endpoint (unreachable local runner, sidecar down) instead of
      // paying the full retry schedule on every round of every turn — see `endpointBreaker`.
      breaker: endpointBreaker(endpoint.id),
      ...(opts.signal ? { signalFor: () => opts.signal, userSignal: opts.signal } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.rng ? { rng: deps.rng } : {}),
      ...(deps.onRetry ? { onRetry: deps.onRetry } : {}),
    });
    if (!res.body) throw new Error(`AI endpoint ${endpoint.id}: empty response body`);

    const decoder = new TextDecoder();
    let buf = "";
    const reader = res.body.getReader();
    // `finally` runs on EVERY exit — normal end, `return` on [DONE], an error, AND a consumer
    // breaking the for-await early (which invokes the generator's .return()). Cancelling the reader
    // releases the lock + closes the response body/socket so nothing leaks or keeps streaming.
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { payloads, rest } = parseSseChunk(buf);
        buf = rest;
        for (const p of payloads) {
          // The FORMAT says what the bytes mean: OpenAI ends on `[DONE]`, Anthropic on a
          // `message_stop` event, and each puts its text and its usage somewhere different.
          const ev = wire.parse(p);
          if (ev.done) return;
          if (ev.usage && onUsage) onUsage(ev.usage);
          if (ev.delta) yield ev.delta;
        }
      }
      // flush any trailing buffered frame (server closed without a final newline).
      const { payloads } = parseSseChunk(`${buf}\n`);
      for (const p of payloads) {
        const ev = wire.parse(p);
        if (ev.done) return;
        if (ev.usage && onUsage) onUsage(ev.usage);
        if (ev.delta) yield ev.delta;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  return {
    async *chat(messages: Msg[], opts: ChatOpts = {}): AsyncIterable<ChatChunk> {
      let usage: SseTokenUsage | undefined;
      for await (const delta of stream(messages, opts, (u) => {
        usage = u;
      })) {
        yield { delta };
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
