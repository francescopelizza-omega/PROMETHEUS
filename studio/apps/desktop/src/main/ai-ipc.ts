/**
 * main/ai-ipc.ts — model chat streaming, in the MAIN process (HANDOFF_2 §9c).
 *
 * The renderer used to `fetch` model endpoints itself. Two problems with that, one of them
 * fatal:
 *
 *  1. The production CSP is `connect-src 'self'` (index.ts). A renderer request to
 *     `http://localhost:11434/v1/chat/completions` — or to any cloud provider — is REFUSED
 *     in the packaged app. It worked under the dev CSP (`http://localhost:*`), so the agent
 *     pane appeared to work in development and could not have worked in a build.
 *  2. It breaks the C5 rule the rest of the app follows: the renderer reaches the outside
 *     world across the contextBridge, never on its own.
 *
 * So the fetch, the SSE parse, the tool-call accumulation and the watchdog live here. The
 * renderer gets presentational deltas on `ai:progress` and the AUTHORITATIVE result — final
 * text, tool calls, usage, timing — as the invoke's typed reply. That split matters: a
 * dropped or duplicated delta is a cosmetic glitch and can never change what the agent loop
 * acts on.
 *
 * The cloud policy (§7.5) is ENFORCED here. The renderer checks it too, so the user gets an
 * instant local error, but that check is a courtesy — this one is the gate.
 */

// TYPE-ONLY: a VALUE import of `electron` cannot be loaded by node:test (the module has no
// ESM named exports outside the Electron runtime), and the streaming logic below is the part
// worth testing. `registerAiIpc` therefore takes `ipcMain` as an argument instead of reaching
// for it — the composition root already has it.
import type { IpcMain, WebContents } from "electron";

import {
  ai,
  settings as coreSettings,
  orchestration,
  secrets as secretsNs,
} from "@prometheus/core";
import { estimateTextTokens } from "@prometheus/core/agent-compact";
import { createCliSecretsStore } from "@prometheus/core/agent-system-host";
import { applyEffort, applyEffortToMessages } from "@prometheus/core/ai-effort";
import type { EffortResolution } from "@prometheus/core/ai-effort";
import {
  describeAiFailure,
  endpointBreaker,
  fetchModelWithRetry,
  preflightContext,
} from "@prometheus/core/ai-retry";

import { getBudgetGate, isLocalModelId } from "./budget-gate.js";

import {
  type AiProbeModelsResult,
  type AiProgressEvent,
  type AiStreamRequest,
  type AiStreamResult,
  type AiToolCall,
  IPC,
  IPC_EVENTS,
} from "../shared/ipc-contract.js";

/**
 * Progress watchdog windows, byte-identical to the CLI (`agent-runtime.ts:787-789`).
 *
 * A large local model can take 30–90s to produce its FIRST byte (cold prefill, weights
 * reload). Without a heartbeat the user cannot tell a slow MODEL from a hung WRAPPER, and
 * without a hard ceiling a wedged runner hangs the pane forever.
 */
const FIRST_TOKEN_TICK_MS = 8_000;
const STREAM_IDLE_TICK_MS = 15_000;
const HARD_TIMEOUT_MS = 180_000;

/** In-flight turns, so `ai:cancel` can abort one by runId. */
const inFlight = new Map<string, AbortController>();

/**
 * `origin → model` for every LOCAL model we asked to stay resident.
 *
 * We send `keep_alive: "30m"` so a multi-round agent turn does not pay a cold weights
 * reload between rounds. The cost of that is real: without this ledger, quitting Studio
 * leaves several GB of a model pinned in RAM for half an hour, with nothing running that
 * could explain why. `freeLocalModels` reverses it on exit.
 */
const residentModels = new Map<string, Set<string>>();

/** The runner's ROOT (Ollama's native API lives there, not under the `/v1` OpenAI shim). */
function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Release the local models we pinned (best effort, on quit).
 *
 * `keep_alive: 0` on Ollama's native `/api/generate` unloads immediately. Anything else
 * ignores the call, which is why the failure path here is "do nothing": this is politeness
 * about the user's RAM, not correctness, and it must never be able to delay or block a
 * quit. The 1.5s ceiling is the whole budget for ALL endpoints.
 */
export async function freeLocalModels(doFetch: typeof fetch = fetch): Promise<void> {
  const entries = [...residentModels.entries()];
  residentModels.clear();
  if (entries.length === 0) return;
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), 1_500);
  try {
    await Promise.allSettled(
      entries.flatMap(([origin, models]) =>
        [...models].map((model) =>
          doFetch(`${origin}/api/generate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, keep_alive: 0 }),
            signal: ac.signal,
          }),
        ),
      ),
    );
  } catch {
    /* quitting: a runner that is already gone is the expected case */
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Classify a base URL as local or cloud, IN MAIN.
 *
 * A deliberate duplicate of the renderer's `localityOf`: this one is the enforcement input, and
 * an enforcement point may not take its deciding fact from the process it is guarding against.
 * Anything that is not demonstrably on this machine is treated as cloud — an unparseable URL
 * included, because "I could not tell" must not resolve to "allowed".
 */
export function localityOfUrl(baseUrl: string): "local" | "cloud" {
  try {
    const u = new URL(baseUrl);
    if (u.protocol === "unix:" || u.protocol === "file:") return "local";
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // URL wraps IPv6 in brackets
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return "local";
    if (h.endsWith(".local")) return "local";
    return "cloud";
  } catch {
    return "cloud";
  }
}

/**
 * Chat-completions URL that tolerates a baseUrl already ending in `/v1`.
 *
 * Kept for the OpenAI-shaped callers that still ask for it by name; the streaming transport
 * now takes its URL from `ai/wire.ts`, which is the only thing that knows Anthropic serves
 * `/v1/messages` and Gemini puts the model in the path.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

/**
 * The renderer's OpenAI-shaped tool schemas → the neutral wire shape.
 *
 * `AiStreamRequest.tools` is typed `unknown[]` and has always carried
 * `{type:"function",function:{name,description,parameters}}`. Anything that does not match
 * that shape is dropped rather than forwarded: a malformed entry is a 400 on every provider,
 * and one bad tool must not cost the whole turn.
 */
function toWireTools(tools: unknown[] | undefined): ai.WireTool[] {
  const out: ai.WireTool[] = [];
  for (const t of tools ?? []) {
    const fn = (t as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })
      ?.function;
    if (!fn || typeof fn.name !== "string") continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: (fn.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    });
  }
  return out;
}

/** Split an SSE buffer into complete `data:` payloads + the unconsumed remainder. */
export function parseSseChunk(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break;
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line.startsWith("data:")) payloads.push(line.slice(5).trim());
  }
  return { payloads, rest };
}

/**
 * Reasoning text, which no wire format models because it is not standard.
 *
 * Reasoning models stream their thinking here while `content` stays empty. Ollama spells the
 * field `reasoning` and other OpenAI-compatible servers `reasoning_content`; neither is in
 * the OpenAI spec, so it is read alongside the neutral event rather than inside it.
 */
function reasoningFrom(payload: string): string | undefined {
  if (!payload.includes("reasoning")) return undefined;
  try {
    const o = JSON.parse(payload) as {
      choices?: Array<{ delta?: { reasoning?: string | null; reasoning_content?: string | null } }>;
    };
    const d = o.choices?.[0]?.delta;
    return d?.reasoning ?? d?.reasoning_content ?? undefined;
  } catch {
    return undefined;
  }
}

/** Token usage as the provider reported it; absent when the endpoint does not send any. */
function usageFrom(obj: unknown): AiStreamResult["usage"] | undefined {
  const u = (obj as { usage?: unknown }).usage as
    | { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
    | undefined;
  if (!u || typeof u !== "object") return undefined;
  const inTok = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
  const outTok = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
  if (inTok === undefined && outTok === undefined) return undefined;
  const inputTokens = inTok ?? 0;
  const outputTokens = outTok ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : inputTokens + outputTokens,
  };
}

/** Send one presentational delta, tolerating a window that closed mid-stream. */
function emit(sender: WebContents | undefined, ev: AiProgressEvent): void {
  if (!sender || sender.isDestroyed()) return;
  sender.send(IPC_EVENTS.aiProgress, ev);
}

/**
 * The security posture every model call is checked against.
 *
 * Module-level because the check has to happen in MAIN — the renderer is the untrusted side, so
 * a policy it evaluates for itself is a suggestion. Defaults to permissive, so a build that
 * never calls `setSecurityPosture` behaves exactly as it did before this existed.
 */
let activePosture: coreSettings.SecurityPosture = coreSettings.securityPosture(undefined);

/** Adopt the resolved settings as the active posture. Called at startup and on every change. */
export function setSecurityPosture(settings: coreSettings.Settings | undefined): void {
  activePosture = coreSettings.securityPosture(settings);
}

/** The posture in force (for the banner / tests). */
export function getSecurityPosture(): coreSettings.SecurityPosture {
  return activePosture;
}

/**
 * Read the settings off disk and adopt the posture, BEFORE any handler can serve a model call.
 *
 * Fail-soft on a missing or unreadable file — that is a fresh install, and refusing to start
 * would be a worse outcome than the permissive default it already had. It is NOT fail-soft on a
 * file that parses: a posture that exists is adopted, and this returning is the guarantee the
 * caller can order against.
 */
export async function adoptSecurityPosture(globalPath: string): Promise<void> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(globalPath, "utf8")) as Record<string, unknown>;
    const profileId =
      typeof raw.profileId === "string" ? raw.profileId : coreSettings.DEFAULT_PROFILE_ID;
    const profile = coreSettings.getProfile(profileId)?.settings;
    setSecurityPosture(
      coreSettings.layerSettings(
        coreSettings.DEFAULT_SETTINGS,
        raw as coreSettings.Settings,
        profile,
      ),
    );
  } catch {
    /* no settings yet (fresh install) — the permissive default stands, as it did before. */
  }
}

/**
 * Run one chat turn against `req.endpoint`, streaming deltas to `sender`.
 *
 * Exported (and fetch-injectable) so the SSE/watchdog/tool-accumulation logic is testable
 * without Electron — the IPC handler below is a thin wrapper around it.
 */
/**
 * Resolve the `Authorization` header for a cloud base URL, or explain why there is none.
 *
 * Env first, keychain second — the same precedence the CLI and the swarm lane use, because an
 * exported variable is an explicit per-invocation override. An unknown provider or a missing
 * key is a REFUSAL with an actionable sentence, never an unauthenticated request: a silent 401
 * three seconds later reads as "the model is broken" rather than "you have not configured it".
 */
async function resolveCloudAuth(
  baseUrl: string,
): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
  const provider = ai.providerForBaseUrl(baseUrl);
  if (!provider) {
    /**
     * An endpoint we do not recognise goes out EXACTLY as it did before: no header.
     *
     * Refusing here would be the wrong kind of strict. A user can point this at a corporate
     * gateway, a self-hosted proxy or an inference server that authenticates some other way
     * (mTLS, a sidecar, nothing at all) — and every one of those works today. We cannot know
     * that such an endpoint needs a key, so assuming it does would break working setups to
     * protect against a 401 they were never going to get.
     */
    return { ok: true, key: "" };
  }
  const fromEnv = orchestration.resolveApiKey(provider.id, process.env);
  if (fromEnv) return { ok: true, key: fromEnv.key };
  try {
    const store = createCliSecretsStore();
    const key = await store.get(secretsNs.SECRETS_SERVICE, `provider:${provider.id}`);
    if (key) return { ok: true, key };
  } catch {
    // No keychain tool on this platform is a normal state; the env branch above is the answer
    // there, and the message below says so.
  }
  return {
    ok: false,
    reason:
      `no API key for ${provider.label} — set $${provider.apiKeyEnv[0]} ` +
      `or run \`prometheus provider connect ${provider.id}\``,
  };
}

export async function runAiStream(
  req: AiStreamRequest,
  sender: WebContents | undefined,
  doFetch: typeof fetch = fetch,
  posture: coreSettings.SecurityPosture = activePosture,
  /**
   * Retry knobs, injected.
   *
   * A test that exercises a 503 would otherwise wait out two real backoff delays, so the
   * suite pays a second per retry test — and a slow suite is a suite people stop running.
   */
  retryOpts: { sleep?: (ms: number) => Promise<void>; retries?: number } = {},
): Promise<AiStreamResult> {
  // §7.5 ENFORCEMENT: refuse a cloud endpoint before anything leaves the machine.
  //
  // TWO sources, and the distinction is the point. `req.neverSendToCloud` is the pane's
  // per-session checkbox; `posture.allowCloud` comes from the active security profile. The
  // profile is a FLOOR the session cannot lower: under `local-only`, unticking the box does not
  // buy cloud back. This is checked in MAIN because the renderer is the untrusted side — its
  // own identical check is a fast local message, not the gate.
  // The locality is RE-DERIVED here from the URL we are about to POST to, never taken from
  // `req`. The request object comes from the renderer — the side this check exists because we
  // do not trust — so a `locality: "local"` label on `https://api.openai.com` would otherwise
  // walk straight past a `local-only` profile. The label is a hint for the UI; the URL is the
  // fact.
  const locality = localityOfUrl(req.endpoint.baseUrl);
  const cloud = coreSettings.cloudAllowed(locality, posture, req.neverSendToCloud);
  if (!cloud.allowed) {
    return {
      ok: false,
      error: `cloud endpoint "${req.endpoint.id}" refused: ${cloud.reason}`,
      text: "",
      toolCalls: [],
    };
  }
  // The network policy governs the endpoint too: `defaultNetwork: "none"` means no remote
  // inference, whatever the endpoint list offers. A LOCAL runner is not remote and is allowed,
  // which is what keeps `local-only` a usable profile rather than a brick.
  const egress = coreSettings.egressAllowed("model", posture, { locality });
  if (!egress.allowed) {
    return {
      ok: false,
      error: `endpoint "${req.endpoint.id}" refused: ${egress.reason}`,
      text: "",
      toolCalls: [],
    };
  }

  /**
   * SPEND CAP (Task #1 item 2) — the desktop's half of the CLI's `checkBudgetGate`.
   *
   * Placed HERE, beside the other two policy refusals and BEFORE the request is built, so an
   * over-budget turn costs nothing at all: no body assembled, no fetch, no tokens. A cap that
   * only reported after the fact would be a receipt, not a cap.
   *
   * The gate is null in any build that never called `initBudgetGate`, and a null gate ALLOWS —
   * the same defaulting rule `activePosture` uses, so nothing changes for a host that has not
   * opted in. `local` endpoints and an unconfigured cap bypass without touching the store.
   */
  const gate = getBudgetGate();
  if (gate) {
    const budget = gate.check({ locality, isLocalModel: isLocalModelId });
    if (budget.action === "block") {
      return {
        ok: false,
        error: budget.message ?? "budget hard-stop",
        text: "",
        toolCalls: [],
      };
    }
    // A warn is surfaced as a progress note rather than swallowed — the point of `warnAtPercent`
    // is that the user finds out BEFORE the cap, not when the turn stops working.
    if (budget.action === "warn" && budget.message) {
      emit(sender, { runId: req.runId, kind: "status", text: budget.message });
    }
  }

  const model = req.endpoint.model ?? req.endpoint.id;
  const effort = req.effort as EffortResolution | undefined;
  /**
   * The FORMAT this endpoint speaks — main used to assume OpenAI's, unconditionally.
   *
   * The picker offers Anthropic and Gemini base URLs, and this process POSTed an OpenAI body
   * to `/v1/chat/completions` on each of them: a 404 against `api.anthropic.com`, where that
   * path does not exist, and a meaningless body against Gemini. Both read to the user as the
   * model being broken. `ai/wire.ts` owns those differences, including tool calling.
   */
  const wire = ai.selectWire(ai.runtimeFromBaseUrl(req.endpoint.baseUrl, locality));
  let body: Record<string, unknown> = {
    ...wire.body(
      applyEffortToMessages(
        // Desktop tool results carry no call id — the renderer's loop does not thread one —
        // so they go as plain `user` context. Two user turns in a row would be a 400 on
        // Anthropic and Gemini; `wire.body` merges them, which is why that must not be
        // pre-flattened into a single string here.
        req.messages.map((m) => ({
          role: m.role === "tool" ? ("user" as const) : m.role,
          content: m.content,
        })),
        effort,
      ),
      {
        model,
        // `locality`, not `req.endpoint.locality`. The comment above the derivation says the
        // renderer's label is never trusted; these three lines were still reading it, so a
        // mislabelled endpoint lost its usage counters and sent Ollama's `keep_alive` to a
        // cloud provider that answers a non-standard field with a 400. Same fact, one source.
        includeUsage: locality === "cloud",
        ...(toWireTools(req.tools).length > 0 ? { tools: toWireTools(req.tools) } : {}),
      },
    ),
    // Ollama extension, ignored elsewhere: keep the model resident so a multi-round agent
    // turn does not pay a cold reload per round. LOCAL only — a cloud endpoint never
    // receives a non-standard field. Recorded in `residentModels` so quitting gives the
    // RAM back rather than leaving it pinned for the next half hour.
    ...(locality === "local" ? { keep_alive: "30m" } : {}),
  };
  if (locality === "local") {
    const origin = originOf(req.endpoint.baseUrl);
    if (origin) {
      const set = residentModels.get(origin) ?? new Set<string>();
      set.add(model);
      residentModels.set(origin, set);
    }
  }
  // last, so an effort constraint is not undone by a field written above it.
  body = applyEffort(body, effort);

  /**
   * The abort controller and the hard deadline, RE-ARMED per attempt.
   *
   * A controller is single-use and this one is also the cancel handle registered in
   * `inFlight`, so a retry has to replace both — otherwise attempt 2 aborts before it starts,
   * three attempts share one 180-second budget, and `ai:cancel` stops aborting the request
   * that is actually running.
   */
  /**
   * Refuse an impossible request here, with a sentence, rather than paying for a 400.
   *
   * Skipped when the renderer sent no window — an unknown window disables the check rather
   * than triggering it, the same sentinel compaction uses.
   */
  const pre = preflightContext({
    estimatedPromptTokens: estimateTextTokens(req.messages.map((m) => m.content)),
    contextWindow: req.endpoint.contextWindow ?? 0,
  });
  if (!pre.ok) {
    return { ok: false, error: pre.reason ?? "the request does not fit", text: "", toolCalls: [] };
  }

  let ac = new AbortController();
  inFlight.set(req.runId, ac);
  let hardTimer: ReturnType<typeof setTimeout> = setTimeout(() => ac.abort(), HARD_TIMEOUT_MS);
  const armAttempt = (): AbortSignal => {
    clearTimeout(hardTimer);
    ac = new AbortController();
    inFlight.set(req.runId, ac); // the cancel handle must point at the LIVE attempt
    hardTimer = setTimeout(() => ac.abort(), HARD_TIMEOUT_MS);
    return ac.signal;
  };

  const requestAt = Date.now();
  let firstTokenAt: number | undefined;
  let text = "";
  let usage: AiStreamResult["usage"];
  const calls = new Map<number, AiToolCall>();
  /** a provider failure reported mid-stream, after the 200 — see the wire's `error` event. */
  let streamError: string | undefined;

  try {
    /**
     * The request, with bounded retries — every desktop turn takes this path, and it made one
     * attempt. A 429 came back as the string `AI endpoint … HTTP 429` and the turn was over.
     *
     * It also READ NO BODY: a 400 that said exactly what was wrong reached the user as a bare
     * status number. `fetchModelWithRetry` carries a bounded slice of it on the error.
     */
    /**
     * Authenticate a CLOUD endpoint — which this process never did.
     *
     * The picker lists eleven cloud base URLs (the engine's `localai endpoints`), main built
     * headers of exactly `content-type` + `accept`, and the word `Authorization` appeared
     * nowhere in any desktop model transport. So every one of those endpoints was offered to
     * the user and answered with a 401.
     *
     * The key is read HERE, per request, and never crosses to the sandboxed renderer — it is
     * resolved from the environment or from the SAME OS keychain entry
     * `prometheus provider connect` writes, so a key configured once works on both surfaces.
     */
    let authHeader: Record<string, string> = {};
    if (locality === "cloud") {
      const auth = await resolveCloudAuth(req.endpoint.baseUrl);
      if (!auth.ok) {
        return { ok: false, error: auth.reason, text: "", toolCalls: [] };
      }
      // The FORMAT decides the credential's shape: a bearer for OpenAI, `x-api-key` plus the
      // mandatory `anthropic-version` for Anthropic, `x-goog-api-key` for Gemini. A bearer
      // sent to the other two authenticates as nobody.
      if (auth.key) authHeader = wire.headers(auth.key);
    }

    let res: Awaited<ReturnType<typeof doFetch>>;
    try {
      res = await fetchModelWithRetry({
        endpointId: req.endpoint.id,
        url: wire.url(req.endpoint.baseUrl, model),
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...authHeader,
          },
          body: JSON.stringify(body),
        },
        doFetch: doFetch as never,
        signalFor: armAttempt,
        // Fail fast on a dead endpoint instead of paying the full retry schedule on every
        // subsequent round — see `endpointBreaker`.
        breaker: endpointBreaker(req.endpoint.id),
        ...(retryOpts.sleep ? { sleep: retryOpts.sleep } : {}),
        ...(retryOpts.retries !== undefined ? { retries: retryOpts.retries } : {}),
        onRetry: (info) =>
          emit(sender, {
            runId: req.runId,
            kind: "status",
            text: `${info.reason} — retrying in ${Math.round(info.delayMs / 1000)}s`,
          }),
      });
    } catch (err) {
      return {
        ok: false,
        error: `AI endpoint ${req.endpoint.id}: ${describeAiFailure(err)}`,
        text,
        toolCalls: [],
      };
    }
    const firstByteAt = Date.now();
    if (!res.body) {
      return {
        ok: false,
        error: `AI endpoint ${req.endpoint.id}: empty body`,
        text,
        toolCalls: [],
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let firstByte = false;
    let done = false;
    // Hold ONE in-flight read across watchdog ticks — a second concurrent read() throws, so
    // the pending promise is re-raced rather than re-issued.
    let pendingRead = reader.read();
    try {
      while (!done && !ac.signal.aborted) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<"TICK">((r) => {
          timer = setTimeout(
            () => r("TICK"),
            firstByte ? STREAM_IDLE_TICK_MS : FIRST_TOKEN_TICK_MS,
          );
        });
        const raced = await Promise.race([pendingRead, tick]);
        if (timer) clearTimeout(timer);
        if (raced === "TICK") {
          const s = Math.round((Date.now() - requestAt) / 1000);
          emit(sender, {
            runId: req.runId,
            kind: "status",
            text: firstByte
              ? `▼ ${model} still generating… (${s}s)`
              : `⏳ waiting for ${model} — no output yet (${s}s). A large local model can take 30–90s to start.`,
          });
          continue; // pendingRead is STILL pending — re-race it
        }
        const { value, done: streamDone } = raced;
        if (streamDone) break;
        firstByte = true;
        buf += decoder.decode(value, { stream: true });
        const { payloads, rest } = parseSseChunk(buf);
        buf = rest;
        for (const payload of payloads) {
          // The FORMAT decodes the frame. This was an inline OpenAI parser, so an Anthropic
          // `content_block_delta` or a Gemini `candidates[]` frame produced nothing at all —
          // a stream that ran to completion and delivered an empty answer.
          const ev = wire.parse(payload);
          // A mid-stream provider failure after a 200: nothing else would ever notice it, and
          // the pane would show an empty answer with no explanation.
          if (ev.error) {
            streamError = ev.error;
            done = true;
            break;
          }
          if (ev.done) {
            done = true;
            break;
          }
          if (ev.usage) usage = ev.usage;
          const thinking = reasoningFrom(payload);
          if (thinking) emit(sender, { runId: req.runId, kind: "reasoning", text: thinking });
          if (ev.delta) {
            // the FIRST content delta is where generation actually starts; everything
            // before it is load, however the runner spent it.
            firstTokenAt ??= Date.now();
            text += ev.delta;
            emit(sender, { runId: req.runId, kind: "text", text: ev.delta });
          }
          if (ev.toolCall) {
            const idx = ev.toolCall.index;
            const acc = calls.get(idx) ?? { id: "", name: "", arguments: "" };
            if (ev.toolCall.id) acc.id = ev.toolCall.id;
            if (ev.toolCall.name) acc.name = ev.toolCall.name;
            if (ev.toolCall.argsFragment) acc.arguments += ev.toolCall.argsFragment;
            calls.set(idx, acc);
          }
        }
        if (!done) pendingRead = reader.read();
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    if (streamError) {
      return { ok: false, error: streamError, text, toolCalls: [] };
    }
    /**
     * Persist what this call cost, so the NEXT one can be gated on it.
     *
     * Without this the desktop cap could never trip: `run-controller`'s `usageMap` is an
     * in-memory `Map` that dies on window reload, so there has never been a durable number to
     * compare a cap against. Recorded only when the provider actually reported usage —
     * inventing token counts would enforce a cap against a number nobody measured.
     */
    if (usage && gate) {
      gate.record({
        locality,
        model,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
      });
    }
    return {
      ok: true,
      text,
      toolCalls: [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([idx, v]) => ({ ...v, id: v.id || `call_${idx}` }))
        .filter((t) => t.name.length > 0),
      ...(usage ? { usage } : {}),
      timing: {
        requestAt,
        firstByteAt,
        ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
        lastByteAt: Date.now(),
      },
    };
  } catch (e) {
    // An abort is a USER action (stop / re-prompt) or the hard timeout, not a failure to
    // report as an error string the pane would paint red.
    if (ac.signal.aborted) return { ok: true, text, toolCalls: [] };
    return { ok: false, error: e instanceof Error ? e.message : String(e), text, toolCalls: [] };
  } finally {
    clearTimeout(hardTimer);
    inFlight.delete(req.runId);
  }
}

/**
 * Probe a LOCAL OpenAI-compatible runner for its served models — `GET {baseUrl}/models`.
 *
 * MOVED HERE from the renderer's `endpoint-hook.ts` (Task #18), same-behavior: a 2.5s bounded
 * attempt, fail-soft on anything short of a parsed `data[].id` list. The renderer called this
 * directly on `window.fetch`, which the production CSP (`connect-src 'self'`, index.ts) refuses
 * for `http://127.0.0.1:<port>` — the exact class of bug `runAiStream` above already exists to
 * avoid for chat completions. `doFetch` is injectable so the timeout/parse logic is testable
 * without Electron, exactly like `runAiStream`.
 */
export async function probeServedModels(
  baseUrl: string,
  doFetch: typeof fetch = fetch,
): Promise<AiProbeModelsResult> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2_500);
    let res: Awaited<ReturnType<typeof doFetch>>;
    try {
      res = await doFetch(url, { method: "GET", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    // A down/unreachable/empty runner is NOT an IPC error — it is the normal "this endpoint has
    // nothing served right now" state, and `expandServedModels` drops it on an empty list either
    // way. `ok:false` here is reserved for a malformed REQUEST (see the handler below).
    if (!res.ok) return { ok: true, models: [] };
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = (Array.isArray(json.data) ? json.data : [])
      .map((m) => String(m?.id ?? ""))
      .filter((id) => id.length > 0);
    return { ok: true, models };
  } catch {
    return { ok: true, models: [] };
  }
}

/** Register `ai:stream` / `ai:cancel` / `ai:probeModels` on the caller's `ipcMain`. */
export function registerAiIpc(ipc: IpcMain): void {
  ipc.handle(IPC.aiStream, async (evt: unknown, arg: unknown): Promise<AiStreamResult> => {
    const req = arg as AiStreamRequest;
    if (!req || typeof req.runId !== "string" || !req.endpoint?.baseUrl) {
      return { ok: false, error: "ai:stream: malformed request", text: "", toolCalls: [] };
    }
    const sender = (evt as { sender?: WebContents } | undefined)?.sender;
    return runAiStream(req, sender);
  });

  ipc.handle(IPC.aiCancel, (_evt: unknown, arg: unknown): boolean => {
    const runId = (arg as { runId?: string } | undefined)?.runId;
    if (!runId) return false;
    const ac = inFlight.get(runId);
    ac?.abort();
    return ac !== undefined;
  });

  ipc.handle(
    IPC.aiProbeModels,
    async (_evt: unknown, arg: unknown): Promise<AiProbeModelsResult> => {
      const baseUrl = (arg as { baseUrl?: unknown } | null)?.baseUrl;
      if (typeof baseUrl !== "string" || baseUrl.length === 0) {
        return { ok: false, models: [], error: "ai:probeModels: malformed request" };
      }
      return probeServedModels(baseUrl);
    },
  );
}
