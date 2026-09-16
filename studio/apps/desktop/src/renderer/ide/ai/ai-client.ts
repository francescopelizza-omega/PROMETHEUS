/**
 * ide/ai/ai-client.ts — the renderer THIN AI client (file 07 §7).
 *
 * The renderer AI surfaces (Cmd-K inline edit, the agent pane, "generate commit
 * message") stream an OpenAI-compatible `/v1/chat/completions` SSE response from a
 * Model Hub endpoint (`window.prometheus.models.endpoints()` → local served URLs).
 * It is a THIN client (file 07 §0/§7.5): NO weights, NO serving, NO security logic —
 * just prompt-build + SSE parse. The provider-agnostic CORE client
 * (`@prometheus/core/ai/client`) is the canonical one (tested against a local SSE
 * stub); the renderer cannot import core's runtime (C5 sandbox), so this mirrors its
 * PURE SSE parsing here, kept identical + independently node:test-ed.
 *
 * Privacy (§7.5): the per-workspace "never send to cloud" policy is enforced BEFORE a
 * request leaves — a cloud endpoint is refused up-front. Local endpoints (the default)
 * are free, offline, private.
 *
 * Renderer-SANDBOXED (C5): uses the global `fetch` (injectable for tests). NO
 * node/electron/engine-bridge. The model endpoint URLs come across the contextBridge.
 * `@prometheus/core/ai-effort` is a PURE subpath (types + math, zero IO) — safe here.
 */

import {
  IdleWatchdog,
  WATCHDOG_FIRST_TICK_MS,
  WATCHDOG_STREAM_TICK_MS,
  raceTicks,
} from "@prometheus/core/agent-idle-watchdog";
import { applyEffort, applyEffortToMessages } from "@prometheus/core/ai-effort";
import type { EffortResolution } from "@prometheus/core/ai-effort";
import { mergeWireUsage } from "@prometheus/core/ai-usage";
import { useAuthorisationStore } from "../../stores/authorisation.js";

/**
 * `keep_alive` for a local request, renderer-side.
 *
 * The renderer is a sandboxed view: it has no `process.env` and may not import `@prometheus/core`
 * wholesale, so it cannot call core's `localKeepAliveField`. It therefore does the safe half of
 * that decision — it sends NOTHING and lets the runner's own configured default win.
 *
 * That is deliberate, not an oversight. This used to send `keep_alive: "30m"`, which overrode the
 * user's standing memory guard (`handoffs/ollama-safe-limits.sh` sets `OLLAMA_KEEP_ALIVE=60s`)
 * and left a model pinned for half an hour after the user stopped typing. If you need a pinned
 * value in the desktop, set `PROMETHEUS_LOCAL_KEEP_ALIVE` and route the request through main's
 * `ai-ipc.ts`, which does read it. Keep this in step with
 * `packages/core/src/ai/local-runners.ts::localKeepAliveField`.
 */
function localKeepAliveField(_locality: string | undefined): { keep_alive?: string } {
  return {};
}

/**
 * handoff §3: per-turn phase timings, measured (not estimated). `load` is everything
 * before the model produced anything — connect, queue, weights load; `model` is the
 * generation itself. A field left undefined means that boundary never happened (e.g.
 * the request failed before the first byte) — the card renders what it has.
 */
export interface TurnTiming {
  /** ms clock at request start. */
  requestAt: number;
  /** ms clock when the response headers resolved (connect + queue done). */
  firstByteAt?: number;
  /** ms clock at the first non-empty content delta (the model is now generating). */
  firstTokenAt?: number;
  /** ms clock when the stream finished. */
  lastByteAt: number;
}

/** `load` / `model` split for one turn, in ms. Never negative. */
export function splitTiming(t: TurnTiming): { load: number; model: number } {
  const start = t.firstTokenAt ?? t.firstByteAt ?? t.lastByteAt;
  return {
    load: Math.max(0, start - t.requestAt),
    model: Math.max(0, t.lastByteAt - start),
  };
}

/** A chat message (OpenAI shape). */
export interface AiMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

/** An endpoint the client streams from (sourced from the Model Hub, §7.5). */
export interface RendererEndpoint {
  /** stable id / display name. */
  id: string;
  baseUrl: string;
  /** local (free/offline/private) vs cloud — gates the privacy policy. */
  locality: "local" | "cloud";
  /** the model name to send in the body (defaults to the id). */
  model?: string;
  /**
   * The model's context window, when it is known.
   *
   * Used to size the tool preamble: the budget is a share of the window, and without a window
   * it falls back to the one sized for 8192 — which drops every tool description from the
   * listing the model is shown. The endpoint picker already derives this from the model
   * catalogue (`endpoints.ts` `contextWindow`), it just never travelled this far.
   */
  contextWindow?: number;
  /**
   * The runner's own capability array (`["completion","tools","thinking","vision",…]`), from
   * Ollama's `/api/show` via `ai:probeEndpoint`.
   *
   * This is the field that makes the effort chip mean something on a local model.
   * `ai/effort/rules.ts` resolves a `/think` tier through rules that match on a PROBED
   * capability first and a model name only as a fallback — deliberately, because model ids are
   * unstable and version-scoped (Gemma 2/3 cannot think, Gemma 4 can). Studio never carried the
   * probe result this far, so `effortFor()` had nothing to hand those rules, every local model
   * fell through to `UNKNOWN_CAPABILITY`, and the chip said "not available" for models that
   * report `thinking` outright.
   *
   * `undefined` ⇒ never probed (a cloud endpoint, or the probe has not landed yet) — which the
   * effort layer treats as "unknown", NOT as "cannot".
   */
  probedCapabilities?: readonly string[];
}

/* ── pure SSE parsing (mirrors @prometheus/core/ai/client — kept identical) ──── */

/** Split an SSE buffer into completed `data:` payloads + the partial tail. */
export function parseSseChunk(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  let nl = rest.indexOf("\n");
  while (nl !== -1) {
    const line = rest.slice(0, nl).replace(/\r$/, "");
    rest = rest.slice(nl + 1);
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) payloads.push(trimmed.slice("data:".length).trim());
    nl = rest.indexOf("\n");
  }
  return { payloads, rest };
}

/** Token usage for one call (mirrors core ai.guardrails TokenUsage). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Extract an OpenAI-compatible `usage` object from one SSE payload → TokenUsage, or null
 * (APP-055). Handles BOTH variants: the final `stream_options.include_usage` chunk (empty
 * `choices` + a populated `usage`) and a `usage` folded into the last content chunk. Skips
 * `[DONE]`; fail-soft on malformed usage (never throws, never returns partial garbage).
 */
export function usageFromPayload(payload: string): TokenUsage | null {
  if (payload === "[DONE]") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  const u = (obj as { usage?: unknown }).usage as
    | { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
    | undefined;
  if (!u || typeof u !== "object") return null;
  const inTok = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
  const outTok = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
  if (inTok === undefined && outTok === undefined) return null; // no usable counts
  const inputTokens = inTok ?? 0;
  const outputTokens = outTok ?? 0;
  const totalTokens =
    typeof u.total_tokens === "number" ? u.total_tokens : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

/** Extract `choices[0].delta.content` (chat) or `.text` (legacy) from one payload. */
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
  const content = first.delta?.content;
  if (typeof content === "string") return content;
  if (typeof first.text === "string") return first.text;
  return "";
}

/**
 * Extract a REASONING delta from one payload (CLI parity, `agent-runtime.ts:906`).
 *
 * Thinking models stream their chain-of-thought on a separate field and leave
 * `delta.content` empty meanwhile. Ollama calls it `reasoning`; several OpenAI-compatible
 * proxies call it `reasoning_content`. Reading only `content` — which is what the GUI did
 * — makes such a model look HUNG for the entire thinking phase: no text, no tool call,
 * nothing to show. Read both, in the CLI's order.
 */
export function reasoningFromPayload(payload: string): string {
  if (payload === "[DONE]") return "";
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return "";
  }
  const choices = (obj as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const delta = (choices[0] as { delta?: { reasoning?: unknown; reasoning_content?: unknown } })
    .delta;
  const r = delta?.reasoning ?? delta?.reasoning_content;
  return typeof r === "string" ? r : "";
}

/* ── the streaming client ────────────────────────────────────────────────────*/

// Progress watchdog + inactivity-pause windows now live in
// `@prometheus/core/agent-idle-watchdog`, SHARED with the CLI and desktop main — this file no
// longer defines its own copies.

/** What the watchdog needs to narrate and to stop. */
interface WatchdogCtl {
  /** the model name to name in the status line. */
  label: string;
  /** ms clock the request started at (for the elapsed counter). */
  startedAt: number;
  /** true once the run has been cancelled (user abort or idle pause). */
  aborted: () => boolean;
  /** a human-facing progress line; absent → the watchdog only enforces the timeout. */
  onStatus?: (text: string) => void;
  /** called on every real chunk — resets the caller's idle countdown. */
  onActivity?: () => void;
}

/**
 * Yield SSE payloads from a response body, emitting a heartbeat while the model is quiet.
 *
 * The one subtlety, and the reason this is shared rather than written twice: exactly ONE
 * `reader.read()` may be in flight at a time — calling it again while the first is pending
 * throws. So the pending read is HELD across watchdog ticks and re-raced, never re-issued.
 * Stops at `[DONE]`; always releases the reader (and its socket) on every exit path,
 * including a consumer `break`.
 */
async function* ssePayloads(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ctl: WatchdogCtl,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buf = "";
  let firstByte = false;
  let pendingRead = reader.read();
  try {
    for (;;) {
      if (ctl.aborted()) break;
      const ticker = raceTicks(
        pendingRead,
        firstByte ? WATCHDOG_STREAM_TICK_MS : WATCHDOG_FIRST_TICK_MS,
        () => {
          const s = Math.round((Date.now() - ctl.startedAt) / 1000);
          return firstByte
            ? `▼ ${ctl.label} still generating… (${s}s)`
            : `⏳ waiting for ${ctl.label} — no output yet (${s}s). A large local model can take 30–90s to start.`;
        },
      );
      let step = await ticker.next();
      while (!step.done) {
        ctl.onStatus?.(step.value);
        step = await ticker.next();
      }
      const { value, done } = step.value;
      if (done) break;
      ctl.onActivity?.();
      firstByte = true;
      buf += decoder.decode(value, { stream: true });
      const { payloads, rest } = parseSseChunk(buf);
      buf = rest;
      for (const p of payloads) {
        if (p === "[DONE]") return;
        yield p;
      }
      pendingRead = reader.read();
    }
    // flush whatever the last partial chunk left behind
    const { payloads } = parseSseChunk(`${buf}\n`);
    for (const p of payloads) {
      if (p === "[DONE]") return;
      yield p;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Test-only clock injection for the idle watchdog — see `IdleWatchdogOptions`'s identical
 *  fields. A real 30s-floor watchdog cannot be exercised with a fast real-timer test, and
 *  production never sets these. */
export interface IdleClockOpts {
  idleWatchdogNow?: () => number;
  idleWatchdogSetTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  idleWatchdogClearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Chain the caller's AbortSignal to our own controller and arm the idle watchdog.
 *
 * We need our OWN controller because an idle pause has to cancel the in-flight fetch, not
 * merely stop consuming it. Returns the controller plus the watchdog (so the caller can
 * `touch()` it on real activity) plus a `dispose` that MUST run in a `finally` — an un-cleared
 * timer keeps the process (and node:test) alive.
 */
function armRun(
  signal?: AbortSignal,
  idleTimeoutMs?: number,
  clock?: IdleClockOpts,
): { ac: AbortController; watchdog: IdleWatchdog; dispose: () => void } {
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const watchdog = new IdleWatchdog({
    idleTimeoutMs,
    onIdle: () => ac.abort(),
    ...(clock?.idleWatchdogNow ? { now: clock.idleWatchdogNow } : {}),
    ...(clock?.idleWatchdogSetTimeout ? { setTimeoutFn: clock.idleWatchdogSetTimeout } : {}),
    ...(clock?.idleWatchdogClearTimeout ? { clearTimeoutFn: clock.idleWatchdogClearTimeout } : {}),
  });
  watchdog.arm();
  return {
    ac,
    watchdog,
    dispose: () => {
      watchdog.dispose();
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Thrown BEFORE any request when the workspace policy forbids a cloud endpoint. */
export class CloudPolicyError extends Error {
  constructor(endpointId: string) {
    super(`cloud endpoint "${endpointId}" refused: workspace "never send to cloud" is on`);
    this.name = "CloudPolicyError";
  }
}

/**
 * Thrown when main's `ai:stream` reply has `ok: false` — i.e. the request actually reached (or
 * attempted to reach) the endpoint and failed. Carries main's breaker snapshot along with the
 * failure, since main is the only process holding the real `CircuitBreaker` instance: without
 * this, a failing turn's breaker state (which main DOES compute and attach to the reply) had no
 * way to reach the caller at all — the error was a bare string, the snapshot silently dropped.
 */
export class AiTurnError extends Error {
  readonly breaker?: BreakerSnapshotView;
  /**
   * The endpoint refused this request BECAUSE it carried tools (main's verdict — see
   * `AiStreamResult.toolsRejected`; the status and body it needs never cross the bridge).
   *
   * A caller that sees this must NOT treat the turn as a dead end: demote the endpoint to the
   * text protocol and retry the SAME turn, which is what the agentic CLI has always done and
   * what the desktop, having never received the fact, never could.
   */
  readonly toolsRejected?: boolean;
  constructor(message: string, breaker?: BreakerSnapshotView, toolsRejected?: boolean) {
    super(message);
    this.name = "AiTurnError";
    if (breaker) this.breaker = breaker;
    if (toolsRejected) this.toolsRejected = true;
  }
}

/**
 * Thrown by `streamChat()` when the INACTIVITY watchdog ended the turn — a PAUSE, not a
 * completion or a failure. `runChatTurn()` already surfaces this correctly via
 * `ChatTurnResult.paused` (its 5 production callers are richer state machines that inspect the
 * whole result); `streamChat()`'s plain `AsyncGenerator<string,…>` contract has no field to carry
 * that on, so before this it silently ended like any other finished turn — a caller had no way to
 * tell "the model paused, nothing was lost, try again" from "the model actually answered nothing".
 */
export class StreamPausedError extends Error {
  constructor() {
    super("model went idle — turn paused (no work lost)");
    this.name = "StreamPausedError";
  }
}

/** The injectable fetch seam (defaults to the global fetch; tests pass a stub). */
export type FetchLike = typeof fetch;

/** Join a base URL + path without doubling/dropping the slash. */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/** Chat-completions URL that tolerates a baseUrl already ending in /v1 (the engine's
 *  `localai endpoints` returns ".../v1") — plain joinUrl would double it to ".../v1/v1/..."
 *  and the runner answers "404 page not found". */
export function chatCompletionsUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(b) ? `${b}/chat/completions` : joinUrl(b, "/v1/chat/completions");
}

/* ── the MAIN-process transport (§9c) ────────────────────────────────────────*/

/**
 * Run one turn through `window.prometheus.ai` (i.e. in MAIN), subscribing to its deltas.
 *
 * This is the DEFAULT path, and it exists because the production CSP is
 * `connect-src 'self'`: a renderer `fetch` to a model endpoint is refused in the packaged
 * app. The renderer streamed models directly, which worked under the dev CSP and could
 * never have worked in a build. Both entry points below keep their `doFetch` option as the
 * direct-fetch escape hatch — it is how the SSE parsers in this file stay unit-testable
 * without Electron, and it is the ONLY thing that still uses them.
 */
async function streamViaMain(
  endpoint: RendererEndpoint,
  messages: AiMsg[],
  opts: {
    tools?: unknown[];
    neverSendToCloud?: boolean;
    signal?: AbortSignal;
    effort?: EffortResolution;
    onText?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    onStatus?: (text: string) => void;
    /** the inactivity-pause threshold for THIS request. Undefined ⇒ the 10-minute default. */
    idleTimeoutMs?: number;
  },
): Promise<ChatTurnResult> {
  const ai = globalThis.window?.prometheus?.ai;
  if (!ai) throw new Error("model streaming is unavailable (no bridge)");
  // A per-turn id: the delta feed is shared by every run, so the subscriber below has to be
  // able to tell ITS bytes from a concurrent turn's.
  const runId = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const off = ai.onProgress((ev) => {
    if (ev.runId !== runId) return;
    if (ev.kind === "text") opts.onText?.(ev.text);
    else if (ev.kind === "reasoning") opts.onReasoning?.(ev.text);
    else opts.onStatus?.(ev.text);
  });
  const onAbort = (): void => void ai.cancel(runId);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (opts.signal?.aborted) return { text: "", toolCalls: [] };
    const r = await ai.stream({
      runId,
      endpoint: {
        id: endpoint.id,
        baseUrl: endpoint.baseUrl,
        ...(endpoint.model ? { model: endpoint.model } : {}),
        locality: endpoint.locality,
        // The window the pane already derived from the catalogue. It sized the tool preamble
        // and stopped there; main needs it to pre-flight a request that cannot possibly fit.
        ...(endpoint.contextWindow ? { contextWindow: endpoint.contextWindow } : {}),
      },
      messages,
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.neverSendToCloud ? { neverSendToCloud: true } : {}),
      // The live session level, so a `plan` posture actually restricts egress. Main MINs it
      // with the persisted level, so this can only tighten — never raise.
      sessionAuthLevel: useAuthorisationStore.getState().level,
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    });
    if (!r.ok) {
      // The cloud-policy refusal keeps its own type so callers can special-case it; main is
      // the enforcer, this just re-labels its answer.
      if (r.error?.includes("never send to cloud")) throw new CloudPolicyError(endpoint.id);
      throw new AiTurnError(
        r.error ?? `AI endpoint ${endpoint.id} failed`,
        r.breaker,
        r.toolsRejected,
      );
    }
    return {
      text: r.text,
      toolCalls: r.toolCalls.map((t) => ({ id: t.id, name: t.name, arguments: t.arguments })),
      ...(r.usage ? { usage: r.usage } : {}),
      ...(r.timing ? { timing: r.timing } : {}),
      ...(r.breaker ? { breaker: r.breaker } : {}),
      ...(r.paused
        ? { paused: true, ...(r.pausedReason ? { pausedReason: r.pausedReason } : {}) }
        : {}),
    };
  } finally {
    off();
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Stream a chat completion from `endpoint`. Yields text deltas. Enforces the cloud
 * policy BEFORE the request leaves (§7.5). Aborts on `signal`. The actual model is
 * the Model Hub's served model — NEVER run/served by the editor (§0).
 */
export async function* streamChat(
  endpoint: RendererEndpoint,
  messages: AiMsg[],
  opts: {
    neverSendToCloud?: boolean;
    signal?: AbortSignal;
    /**
     * DIRECT-fetch escape hatch. Omitted (the default) the turn runs in MAIN, because the
     * production CSP is `connect-src 'self'` and a renderer fetch is refused there. Passing
     * it keeps the request in the renderer, which is how the SSE parsing in this file stays
     * unit-testable without Electron.
     */
    doFetch?: FetchLike;
    /**
     * The reasoning-effort resolution for THIS endpoint (from `@prometheus/core/ai-effort`
     * `resolveEffort`). Its patch lands on the body or the messages depending on the
     * model's mechanism — an enum field, a template kwarg, or a literal prompt line — which
     * is why the caller resolves it and we just apply it. Omitted → nothing is sent.
     */
    effort?: EffortResolution;
    /**
     * Heartbeat while the model is quiet (see `@prometheus/core/agent-idle-watchdog`).
     * Without it a cold local model looks identical to a hung wrapper.
     */
    onStatus?: (text: string) => void;
    /** the inactivity-pause threshold for THIS request. Undefined ⇒ the 10-minute default. */
    idleTimeoutMs?: number;
  } & IdleClockOpts = {},
): AsyncGenerator<string, void, unknown> {
  if (opts.neverSendToCloud && endpoint.locality === "cloud") {
    throw new CloudPolicyError(endpoint.id);
  }
  if (!opts.doFetch) {
    // DEFAULT: stream in main (the prod CSP forbids a renderer fetch — see streamViaMain).
    // The text arrives on the delta feed, so re-yield it through a queue as it lands rather
    // than waiting for the turn to finish; a "streaming" answer that appears all at once at
    // the end is not streaming.
    const queue: string[] = [];
    let notify: (() => void) | undefined;
    let finished = false;
    let failed: unknown;
    let result: ChatTurnResult | undefined;
    const turn = streamViaMain(endpoint, messages, {
      ...(opts.neverSendToCloud ? { neverSendToCloud: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
      onText: (d) => {
        queue.push(d);
        notify?.();
      },
    })
      .then((r) => {
        result = r;
        return r;
      })
      .catch((e: unknown) => {
        failed = e;
        return undefined;
      })
      .finally(() => {
        finished = true;
        notify?.();
      });
    for (;;) {
      while (queue.length > 0) yield queue.shift() as string;
      if (finished) break;
      await new Promise<void>((r) => {
        notify = r;
      });
      notify = undefined;
    }
    await turn;
    if (failed) throw failed;
    // A PAUSE, not a completion — see `StreamPausedError`'s own doc comment. Whatever text
    // already streamed above (via `onText`/the queue) is already in the caller's hands.
    if (result?.paused) throw new StreamPausedError();
    return;
  }
  const doFetch = opts.doFetch;
  const model = endpoint.model ?? endpoint.id;
  const body = applyEffort(
    {
      model,
      messages: applyEffortToMessages(messages, opts.effort),
      stream: true,
      ...localKeepAliveField(endpoint.locality),
    },
    opts.effort,
  );
  const { ac, watchdog, dispose } = armRun(opts.signal, opts.idleTimeoutMs, opts);
  try {
    const res = await doFetch(chatCompletionsUrl(endpoint.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`AI endpoint ${endpoint.id} HTTP ${res.status}`);
    if (!res.body) throw new Error(`AI endpoint ${endpoint.id}: empty body`);
    // ssePayloads owns reader cleanup on EVERY exit path — an early `return`, a consumer
    // `break`/throw, or an abort — so the reader lock and socket cannot leak.
    const frames = ssePayloads(res.body.getReader(), {
      label: model,
      startedAt: Date.now(),
      aborted: () => ac.signal.aborted,
      onActivity: () => watchdog.touch(),
      ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
    });
    // Our OWN idle watchdog (not the caller's signal) ended the stream — a PAUSE, not a
    // completion — mirroring `runChatTurn`'s identical check.
    const isIdlePause = (): boolean =>
      ac.signal.aborted && !opts.signal?.aborted && watchdog.didFire();
    try {
      for await (const p of frames) {
        const delta = deltaFromPayload(p);
        if (delta) yield delta;
      }
    } catch (err) {
      // `ssePayloads`'s `ctl.aborted()` check only catches an abort landing BETWEEN reads — an
      // abort that lands while a `reader.read()` is already pending (the realistic case: the
      // idle window has been counting down the WHOLE time a read sat unanswered) instead
      // REJECTS that read, so this throws here rather than the loop exiting cleanly. Every
      // delta streamed before the pause was already yielded above regardless of which path it
      // took to get here.
      if (!isIdlePause()) throw err;
    }
    if (isIdlePause()) throw new StreamPausedError();
  } finally {
    dispose();
  }
}

/** Build the Cmd-K inline-edit prompt (selection + context + instruction, §7.1). */
export function buildInlineEditMessages(req: {
  instruction: string;
  selection: string;
  context?: string;
  languageId?: string;
}): AiMsg[] {
  const user = [
    req.context ? `Context:\n${req.context}\n` : "",
    `Language: ${req.languageId ?? "plaintext"}`,
    `Instruction: ${req.instruction}`,
    `Selected code:\n${req.selection}`,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You are a code-editing assistant. Rewrite ONLY the selected code per the " +
        "instruction. Return the replacement code with no commentary, no fences.",
    },
    { role: "user", content: user },
  ];
}

/* ── tool calling (the agentic loop, §7.2/§7.3) ──────────────────────────────*/

/** One resolved tool call the model requested (OpenAI function-call shape). */
export interface ToolCall {
  id: string;
  name: string;
  /** the raw JSON-string arguments (parse at the call site; may be partial/garbage). */
  arguments: string;
}

/** A per-index accumulator for streamed tool-call fragments. */
export type ToolCallAccumulator = Map<number, { id: string; name: string; args: string }>;

/**
 * Fold one SSE payload's `choices[0].delta.tool_calls` fragments into `acc` (OpenAI
 * streams tool calls incrementally: `function.arguments` arrives in pieces keyed by
 * `index`). PURE + defensive — ignores non-tool-call / malformed payloads.
 */
export function accumulateToolCalls(acc: ToolCallAccumulator, payload: string): void {
  if (payload === "[DONE]") return;
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return;
  }
  const choices = (obj as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return;
  const tcs = (choices[0] as { delta?: { tool_calls?: unknown } }).delta?.tool_calls;
  if (!Array.isArray(tcs)) return;
  for (const raw of tcs) {
    const tc = raw as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const idx = typeof tc.index === "number" ? tc.index : 0;
    const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
    if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
    if (tc.function) {
      if (typeof tc.function.name === "string" && tc.function.name) cur.name = tc.function.name;
      if (typeof tc.function.arguments === "string") cur.args += tc.function.arguments;
    }
    acc.set(idx, cur);
  }
}

/** Finalize the accumulator into ordered ToolCalls (drops fragments with no name). */
export function finalizeToolCalls(acc: ToolCallAccumulator): ToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, v]) => ({ id: v.id || `call_${idx}`, name: v.name, arguments: v.args }))
    .filter((t) => t.name.length > 0);
}

/** Snapshot of the circuit breaker main-process's request layer keeps for this endpoint —
 *  main is the only process that holds the real instance (the renderer's own model-request
 *  code path is the direct-fetch escape hatch, only ever used by tests), so this rides back
 *  on the response instead of the renderer trying to query one of its own. */
export interface BreakerSnapshotView {
  state: "closed" | "open" | "half-open";
  failures: number;
  openedAt: number | null;
}

/** The result of one agent turn: the assistant text + any tool calls it requested. */
export interface ChatTurnResult {
  text: string;
  toolCalls: ToolCall[];
  /** token usage when the endpoint reported it (APP-055); absent = unknown (fail-soft). */
  usage?: TokenUsage;
  /** handoff §3: the measured phase boundaries for this turn (feeds the latency card). */
  timing?: TurnTiming;
  /** absent only when this turn ran through the direct-fetch escape hatch (tests). */
  breaker?: BreakerSnapshotView;
  /** true iff this turn ended in a PAUSE rather than a completion. `text`/`toolCalls` carry
   *  whatever had already streamed before it. See `pausedReason` for WHY. */
  paused?: boolean;
  /**
   * Why the turn paused. Absent means `idle`.
   *
   * Main sets this on the wire and it used to be dropped here, so a pause caused by the RAM
   * ceiling force-stopping (or refusing to restart) the local runner was reported with the
   * inactivity watchdog's wording — "model went idle" — and the one piece of actionable advice
   * ("retry once memory frees up; Prometheus will restart the runner") never reached the user.
   */
  pausedReason?: "idle" | "resources-critical";
}

/**
 * Run ONE chat turn that may request tool calls. Streams assistant text via `onText`
 * AND accumulates tool calls, returning both. Sends `tools` when provided (a model
 * without tool support simply returns text — no regression). Same cloud-policy gate +
 * reader cleanup as streamChat.
 */
export async function runChatTurn(
  endpoint: RendererEndpoint,
  messages: AiMsg[],
  opts: {
    tools?: unknown[];
    neverSendToCloud?: boolean;
    signal?: AbortSignal;
    /**
     * DIRECT-fetch escape hatch. Omitted (the default) the turn runs in MAIN, because the
     * production CSP is `connect-src 'self'` and a renderer fetch is refused there. Passing
     * it keeps the request in the renderer, which is how the SSE parsing in this file stays
     * unit-testable without Electron.
     */
    doFetch?: FetchLike;
    onText?: (delta: string) => void;
    /**
     * A THINKING delta (`delta.reasoning` / `delta.reasoning_content`). Reasoning models
     * emit nothing on `content` while they think, so without this the pane shows a blank
     * turn for the whole thinking phase and the run reads as hung.
     */
    onReasoning?: (delta: string) => void;
    /** heartbeat while the model is quiet (see `@prometheus/core/agent-idle-watchdog`). */
    onStatus?: (text: string) => void;
    /** the resolved reasoning effort for this endpoint (see streamChat). */
    effort?: EffortResolution;
    /** the inactivity-pause threshold for THIS request. Undefined ⇒ the 10-minute default. */
    idleTimeoutMs?: number;
  } & IdleClockOpts = {},
): Promise<ChatTurnResult> {
  if (opts.neverSendToCloud && endpoint.locality === "cloud") {
    throw new CloudPolicyError(endpoint.id);
  }
  if (!opts.doFetch) {
    // DEFAULT: run the turn in main (see streamViaMain). Tool calls, usage and timing come
    // back in its typed reply, so nothing about the loop's decisions rides on the deltas.
    return streamViaMain(endpoint, messages, {
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.neverSendToCloud ? { neverSendToCloud: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.onText ? { onText: opts.onText } : {}),
      ...(opts.onReasoning ? { onReasoning: opts.onReasoning } : {}),
      ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
    });
  }
  const doFetch = opts.doFetch;
  const model = endpoint.model ?? endpoint.id;
  let body: Record<string, unknown> = {
    model,
    messages: applyEffortToMessages(messages, opts.effort),
    stream: true,
    // Ollama extension, ignored elsewhere (CLI parity, `agent-runtime.ts:825`): keep the
    ...localKeepAliveField(endpoint.locality),
  };
  // APP-055: ask cloud (OpenAI-compatible) endpoints for token usage on the final chunk.
  // Gated to cloud so a strict local server (llama.cpp/older proxies) never 400s on the
  // unknown field; local usage that arrives anyway is still parsed fail-soft below.
  if (endpoint.locality === "cloud") {
    body.stream_options = { include_usage: true };
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  // last, so an effort constraint (suppress temperature, raise max_tokens) is not undone
  // by a field written above it.
  body = applyEffort(body, opts.effort);
  // §3 latency attribution — measured at the real boundaries, never estimated.
  const requestAt = Date.now();
  let firstTokenAt: number | undefined;
  const { ac, watchdog, dispose } = armRun(opts.signal, opts.idleTimeoutMs, opts);
  const res = await doFetch(chatCompletionsUrl(endpoint.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: ac.signal,
  }).catch((e: unknown) => {
    dispose();
    throw e;
  });
  // headers resolved → connect + queue + (for a cold local runner) weights load are done.
  const firstByteAt = Date.now();
  if (!res.ok) {
    dispose();
    throw new Error(`AI endpoint ${endpoint.id} HTTP ${res.status}`);
  }
  if (!res.body) {
    dispose();
    throw new Error(`AI endpoint ${endpoint.id}: empty body`);
  }

  let text = "";
  let usage: TokenUsage | undefined;
  const acc: ToolCallAccumulator = new Map();
  const consume = (p: string): void => {
    if (p === "[DONE]") return;
    const thinking = reasoningFromPayload(p);
    if (thinking) opts.onReasoning?.(thinking);
    const delta = deltaFromPayload(p);
    if (delta) {
      // the FIRST content delta is where generation actually starts; everything before
      // it is load, however the runner spent it.
      firstTokenAt ??= Date.now();
      text += delta;
      opts.onText?.(delta);
    }
    accumulateToolCalls(acc, p);
    const u = usageFromPayload(p); // the include_usage chunk has empty choices — safe
    if (u) usage = mergeWireUsage(usage, u);
  };
  // Our OWN idle watchdog (not the caller's signal) ended the stream — a PAUSE, not a
  // completion.
  const isIdlePause = (): boolean =>
    ac.signal.aborted && !opts.signal?.aborted && watchdog.didFire();
  const result = (): ChatTurnResult => ({
    text,
    toolCalls: finalizeToolCalls(acc),
    ...(usage ? { usage } : {}),
    timing: {
      requestAt,
      ...(firstByteAt !== undefined ? { firstByteAt } : {}),
      ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
      lastByteAt: Date.now(),
    },
    // `text`/`toolCalls` above already reflect everything streamed before the pause.
    ...(isIdlePause() ? { paused: true } : {}),
  });
  try {
    // ssePayloads stops AT `[DONE]` and yields everything before it, so a provider that
    // sends `usage` and then `[DONE]` still has its usage folded in — and it owns reader
    // cleanup on every exit path.
    const frames = ssePayloads(res.body.getReader(), {
      label: model,
      startedAt: requestAt,
      aborted: () => ac.signal.aborted,
      onActivity: () => watchdog.touch(),
      ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
    });
    try {
      for await (const p of frames) consume(p);
    } catch (err) {
      // `ssePayloads`'s `ctl.aborted()` check only catches an abort landing BETWEEN reads — an
      // abort landing while a `reader.read()` is already pending (the realistic case for an
      // idle pause: the read had been unanswered for the whole idle window) instead REJECTS
      // that read, so this throws here rather than the loop exiting cleanly. `text`/`toolCalls`
      // accumulated before the pause are unaffected either way.
      if (!isIdlePause()) throw err;
    }
  } finally {
    dispose();
  }
  return result();
}
