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
 */

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

/* ── the streaming client ────────────────────────────────────────────────────*/

/** Thrown BEFORE any request when the workspace policy forbids a cloud endpoint. */
export class CloudPolicyError extends Error {
  constructor(endpointId: string) {
    super(`cloud endpoint "${endpointId}" refused: workspace "never send to cloud" is on`);
    this.name = "CloudPolicyError";
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

/**
 * Stream a chat completion from `endpoint`. Yields text deltas. Enforces the cloud
 * policy BEFORE the request leaves (§7.5). Aborts on `signal`. The actual model is
 * the Model Hub's served model — NEVER run/served by the editor (§0).
 */
export async function* streamChat(
  endpoint: RendererEndpoint,
  messages: AiMsg[],
  opts: { neverSendToCloud?: boolean; signal?: AbortSignal; doFetch?: FetchLike } = {},
): AsyncGenerator<string, void, unknown> {
  if (opts.neverSendToCloud && endpoint.locality === "cloud") {
    throw new CloudPolicyError(endpoint.id);
  }
  const doFetch = opts.doFetch ?? fetch;
  const res = await doFetch(chatCompletionsUrl(endpoint.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: endpoint.model ?? endpoint.id, messages, stream: true }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new Error(`AI endpoint ${endpoint.id} HTTP ${res.status}`);
  if (!res.body) throw new Error(`AI endpoint ${endpoint.id}: empty body`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // Release the reader (and the underlying HTTP connection) on EVERY exit path — an
  // early `return`, a consumer `break`/throw, or an abort. Without this the reader lock
  // and socket leak whenever the caller stops consuming before the stream ends.
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { payloads, rest } = parseSseChunk(buf);
      buf = rest;
      for (const p of payloads) {
        if (p === "[DONE]") return;
        const delta = deltaFromPayload(p);
        if (delta) yield delta;
      }
    }
    const { payloads } = parseSseChunk(`${buf}\n`);
    for (const p of payloads) {
      if (p === "[DONE]") return;
      const delta = deltaFromPayload(p);
      if (delta) yield delta;
    }
  } finally {
    await reader.cancel().catch(() => {});
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

/** The result of one agent turn: the assistant text + any tool calls it requested. */
export interface ChatTurnResult {
  text: string;
  toolCalls: ToolCall[];
  /** token usage when the endpoint reported it (APP-055); absent = unknown (fail-soft). */
  usage?: TokenUsage;
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
    doFetch?: FetchLike;
    onText?: (delta: string) => void;
  } = {},
): Promise<ChatTurnResult> {
  if (opts.neverSendToCloud && endpoint.locality === "cloud") {
    throw new CloudPolicyError(endpoint.id);
  }
  const doFetch = opts.doFetch ?? fetch;
  const body: Record<string, unknown> = {
    model: endpoint.model ?? endpoint.id,
    messages,
    stream: true,
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
  const res = await doFetch(chatCompletionsUrl(endpoint.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new Error(`AI endpoint ${endpoint.id} HTTP ${res.status}`);
  if (!res.body) throw new Error(`AI endpoint ${endpoint.id}: empty body`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let usage: TokenUsage | undefined;
  const acc: ToolCallAccumulator = new Map();
  const consume = (p: string): void => {
    if (p === "[DONE]") return;
    const delta = deltaFromPayload(p);
    if (delta) {
      text += delta;
      opts.onText?.(delta);
    }
    accumulateToolCalls(acc, p);
    const u = usageFromPayload(p); // the include_usage chunk has empty choices — safe
    if (u) usage = u;
  };
  const result = (): ChatTurnResult => ({
    text,
    toolCalls: finalizeToolCalls(acc),
    ...(usage ? { usage } : {}),
  });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { payloads, rest } = parseSseChunk(buf);
      buf = rest;
      for (const p of payloads) {
        // some providers send `usage` THEN `[DONE]`; capture usage before returning.
        if (p === "[DONE]") return result();
        consume(p);
      }
    }
    const { payloads } = parseSseChunk(`${buf}\n`);
    for (const p of payloads) consume(p);
  } finally {
    await reader.cancel().catch(() => {});
  }
  return result();
}
