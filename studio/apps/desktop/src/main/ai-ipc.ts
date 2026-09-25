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
  PROBE_CACHE_TTL_MS,
  ai,
  cliProfiles,
  settings as coreSettings,
  localKeepAliveField,
  orchestration,
  probeContextWindow,
  secrets as secretsNs,
} from "@prometheus/core";
import { DEFAULT_AUTH_LEVEL, NETWORK_AUTH_LEVEL } from "@prometheus/core/agent-authorization";
import { estimateTextTokens } from "@prometheus/core/agent-compact";
import {
  IdleWatchdog,
  WATCHDOG_FIRST_TICK_MS,
  WATCHDOG_STREAM_TICK_MS,
  clearPossibleOrphan,
  markPossibleOrphan,
  orphanGraceRemainingMs,
  raceTicks,
} from "@prometheus/core/agent-idle-watchdog";
import { looksLikeToolsRejection } from "@prometheus/core/agent-protocol";
import { createCliSecretsStore } from "@prometheus/core/agent-system-host";
import { applyEffort, applyEffortToMessages } from "@prometheus/core/ai-effort";
import type { EffortResolution } from "@prometheus/core/ai-effort";
import {
  AiHttpError,
  describeAiFailure,
  endpointBreaker,
  fetchModelWithRetry,
  preflightContext,
} from "@prometheus/core/ai-retry";
import {
  type EvictionEvent,
  findRecentEviction,
  readEvictionEvents,
} from "@prometheus/engine-bridge";

import { getBudgetGate, isLocalModelId } from "./budget-gate.js";
import { touchModelActivity } from "./model-activity-store.js";

/**
 * Native tool calls as they accumulate, keyed by the wire's GROUPING key rather than by
 * `tc.index` alone.
 *
 * `index` groups the fragments of one streamed call — what OpenAI and Anthropic need. A provider
 * that hands a call over WHOLE (Gemini) numbers it by its position inside the chunk it arrived
 * in, so one call per chunk means `index: 0` for every call. Keyed on that alone, two different
 * calls shared a slot: the later name won, the two argument objects were concatenated into
 * something that does not parse, and BOTH calls were destroyed. `WireToolCallFragment.complete`
 * is the flag that says "never merge this one". Identical fix in the CLI's `agent-runtime.ts`.
 */
interface ToolCallAccumulator {
  map: Map<string, AiToolCall>;
  /** first-seen sequence per key, so calls emit in arrival order. */
  order: Map<string, number>;
  seen: number;
  wholeSeq: number;
}

function newToolCallAccumulator(): ToolCallAccumulator {
  return { map: new Map(), order: new Map(), seen: 0, wholeSeq: 0 };
}

/** Merge one wire fragment into the accumulator, honouring `complete`. */
function accumulateCall(
  acc: ToolCallAccumulator,
  tc: { index: number; id?: string; name?: string; argsFragment?: string; complete?: boolean },
): void {
  const key = tc.complete === true ? `whole:${acc.wholeSeq++}` : `idx:${tc.index}`;
  const cur = acc.map.get(key) ?? { id: "", name: "", arguments: "" };
  if (tc.id) cur.id = tc.id;
  if (tc.name) cur.name = tc.name;
  if (tc.argsFragment) cur.arguments += tc.argsFragment;
  if (!acc.order.has(key)) acc.order.set(key, acc.seen++);
  acc.map.set(key, cur);
}

/**
 * The accumulated tool-call map, in wire order, as the result's `toolCalls`.
 *
 * `completeOnly` drops any call whose arguments are not parseable JSON — for a stream that
 * ended EARLY (an idle pause), where a call can be cut mid-`arguments`. A truncated argument
 * string parses to `{}` downstream, and running `write_file` with no arguments is a worse
 * outcome than not running it.
 */
function harvestCalls(
  calls: ToolCallAccumulator,
  opts: { completeOnly?: boolean } = {},
): AiToolCall[] {
  const out = [...calls.map.entries()]
    .sort((a, b) => (calls.order.get(a[0]) ?? 0) - (calls.order.get(b[0]) ?? 0))
    .map(([key, v]) => ({ ...v, id: v.id || `call_${key}` }))
    .filter((t) => t.name.length > 0);
  if (!opts.completeOnly) return out;
  return out.filter((t) => {
    const raw = t.arguments.trim();
    if (raw === "") return true; // a genuinely argument-less tool
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  });
}

import {
  type AiProbeEndpointResult,
  type AiProbeModelsResult,
  type AiProgressEvent,
  type AiStreamRequest,
  type AiStreamResult,
  type AiToolCall,
  IPC,
  IPC_EVENTS,
} from "../shared/ipc-contract.js";

/**
 * Progress watchdog + inactivity-pause windows — SHARED with the CLI via
 * `@prometheus/core/agent-idle-watchdog` (was three independent copies of a flat 180s hard
 * timeout; see that module's header).
 */

/** In-flight turns, so `ai:cancel` can abort one by runId. */
const inFlight = new Map<string, AbortController>();

/**
 * `origin → model` for every LOCAL model we asked to stay resident.
 *
 * We no longer pin `keep_alive` per request — see `localKeepAliveField` in
 * `packages/core/src/ai/local-runners.ts` for why (a hardcoded "30m" overrode the user's own
 * `OLLAMA_KEEP_ALIVE=60s` memory guard and left GBs resident for half an hour after the last
 * prompt). The runner's configured default now decides, and a multi-round turn stays warm
 * anyway because each request restarts the runner's idle timer.
 *
 * This ledger still matters: whatever the runner's timeout is, quitting Studio should not wait
 * for it. `freeLocalModels` evicts on exit what we caused to be loaded.
 */
const residentModels = new Map<string, Set<string>>();

/**
 * ACTIVE EVICTION: was `baseUrl`'s runner JUST force-stopped under critical RAM pressure?
 * Checked at BOTH of `runAiStream`'s failure sites — the connection never even reaching the
 * endpoint (the common case: a cold request made after the eviction) and a stream that dies
 * mid-response (the rarer case: the eviction lands while this exact request was in flight) —
 * so either one gets the same resumable "paused" treatment instead of a red error. Thin wrapper
 * around engine-bridge's shared `findRecentEviction` (which takes an already-resolved runnerId,
 * so it stays free of a `@prometheus/core` dependency) — this half just resolves the baseUrl.
 */
function findRecentEndpointEviction(
  baseUrl: string,
  readEvictions: typeof readEvictionEvents,
): EvictionEvent | undefined {
  return findRecentEviction(ai.runnerForBaseUrl(baseUrl)?.id, readEvictions);
}

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
    // Same rule as loadEffective: an implicit profile may tighten, never widen.
    const { profile } = coreSettings.resolveProfileLayer(raw, {
      defaults: coreSettings.DEFAULT_SETTINGS,
      layer: coreSettings.layerSettings,
      sanitize: coreSettings.sanitizeWorkspaceLayer,
    });
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
   *
   * `idleWatchdogNow`/`idleWatchdogSetTimeout`/`idleWatchdogClearTimeout` are the SAME
   * test-only clock-injection seam `toolTurn` (CLI) and `stream()` (`ai/client.ts`) already
   * expose — this file had none, so its idle-timeout/pause path had zero test coverage: a real
   * `MIN_IDLE_TIMEOUT_MS` floor (30s) made it too slow to exercise honestly.
   */
  retryOpts: {
    sleep?: (ms: number) => Promise<void>;
    retries?: number;
    idleWatchdogNow?: () => number;
    idleWatchdogSetTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
    idleWatchdogClearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
    /**
     * The saved authorisation level, injected.
     *
     * Production omits it and the shared on-disk store answers. It is a SEAM because the
     * alternative is a policy test whose result depends on the level the developer happens
     * to have saved on their own machine — which is exactly what happened when this gate
     * landed: five existing cloud tests started failing on a box whose
     * `~/.prometheus/config/authorisation.json` says `{"level": 1}`.
     */
    readAuthLevel?: () => number | null;
    /**
     * The Ollama-autostart gate, injected — OMITTED BY DEFAULT, the opposite of every other
     * seam in this list.
     *
     * Every one of this file's existing tests drives a single-shape mocked `doFetch` and
     * asserts an exact call count / exact canned response per attempt (a 4xx retried zero
     * times, a 429 honouring `Retry-After`, …). Defaulting this to the real
     * `ai.ensureOllamaRunning` would silently consume one of those calls for its own `/models`
     * probe — wrong count — and, the moment that mocked probe reads as "unreachable", fall
     * through to the REAL `canStart`/`listenersOnPort`/`startModelServer` (actual `lsof`/`which`
     * shell-outs) from inside a unit test. So this is opt-in: production's one real call site
     * (the `ai:stream` IPC handler below) passes `ai.ensureOllamaRunning` explicitly; every
     * test that does not ask for this behaviour is completely unaffected by it.
     */
    ensureOllamaRunningFn?: typeof ai.ensureOllamaRunning;
    /** LM Studio's twin of `ensureOllamaRunningFn` above — same opt-in reasoning, same real
     *  production call site (the `ai:stream` handler passes `ai.ensureLmStudioRunning`). */
    ensureLmStudioRunningFn?: typeof ai.ensureLmStudioRunning;
    /**
     * The shared eviction-log reader, injected — defaults to the real `readEvictionEvents`
     * (unlike `ensureOllamaRunningFn` above, this is safe to default-on: a fail-soft local
     * JSON read, never a spawn/shell-out, and a missing/empty log — the common case on any
     * machine that has never evicted anything — makes this whole branch a no-op). Tests that
     * want to exercise the ACTIVE EVICTION "mid-request" path inject a fake array instead of
     * writing a real file.
     */
    readEvictionEventsFn?: typeof readEvictionEvents;
  } = {},
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
   * AUTHORISATION LADDER — the third policy floor, and the one Studio was only DRAWING.
   *
   * The Model Hub greys every cloud endpoint below A5 and labels it "key in keychain ·
   * A5+ only" (handoff_3 §3). Nothing enforced it: `CLOUD_MIN_AUTH` drove an `opacity` and
   * a note string and had no reader outside that view, so the label described an intention,
   * not a control — and a user at A0 with a key in the keychain reached the cloud exactly as
   * easily as one at A7.
   *
   * Enforced HERE for the same reason the two checks above are: the renderer is the
   * untrusted side. The level is read from the shared on-disk store the CLI and the GUI both
   * own, not from the request, so a renderer cannot hand us a level. The rung is derived from
   * core's ladder (`NETWORK_AUTH_LEVEL`), not written as a `5` a second time.
   *
   * Fail-soft on the READ only: an unreadable store leaves `readSavedAuthLevel` null, which
   * means "never chosen" — the ladder's own default applies, exactly as it does at startup.
   */
  if (locality === "cloud") {
    const saved =
      (retryOpts.readAuthLevel ?? cliProfiles.readSavedAuthLevel)() ?? DEFAULT_AUTH_LEVEL;
    /**
     * MIN of the persisted level and the live session level.
     *
     * The GUI's coarse posture dial is session-scoped by design — `plan` drives the level to
     * 0 without writing the file, because mode→level is lossy and persisting it would
     * overwrite an explicit `/authorisation 7`. The consequence was that main, which reads
     * only the file, let a read-only `plan` posture ship a conversation to a cloud provider.
     *
     * Taking the MIN accepts a value from the untrusted renderer safely: it can lower the
     * ceiling, never raise it. A missing field behaves exactly as before.
     */
    const session =
      typeof req.sessionAuthLevel === "number" && Number.isFinite(req.sessionAuthLevel)
        ? Math.max(0, Math.min(Math.trunc(req.sessionAuthLevel), 7))
        : saved;
    const level = Math.min(saved, session);
    if (level < NETWORK_AUTH_LEVEL) {
      return {
        ok: false,
        error:
          `cloud endpoint "${req.endpoint.id}" refused: authorisation A${level} is below ` +
          `A${NETWORK_AUTH_LEVEL} (network). Raise it with /authorisation to reach a cloud model.`,
        text: "",
        toolCalls: [],
      };
    }
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

  /**
   * AUTOSTART: bring the endpoint's own local runner up if it's merely stopped, before the
   * request below fails against it. The CLI has done this at session boot since onboarding.ts;
   * desktop had nothing at all, so a stopped Ollama (or LM Studio) just failed with no
   * explanation on the very first message.
   *
   * Dispatched on `runnerForBaseUrl(...).id` specifically, not merely "local" — an LM Studio
   * endpoint must never have Ollama started underneath it, or vice versa; each `ensureXRunning`
   * only ever touches its OWN runner's port. `req.endpoint.model` is threaded through so an
   * already-picked model is never silently swapped for the zero-config default (see
   * `ensureOllamaRunning`'s docstring) — this call is a no-op cost when the runner already answers.
   */
  const endpointRunnerId = ai.runnerForBaseUrl(req.endpoint.baseUrl)?.id;
  const ensureRunnerRunningFn =
    endpointRunnerId === "ollama"
      ? retryOpts.ensureOllamaRunningFn
      : endpointRunnerId === "lmstudio"
        ? retryOpts.ensureLmStudioRunningFn
        : undefined; // an unmatched/vLLM-style local endpoint: neither autostart ever applies.
  if (locality === "local" && ensureRunnerRunningFn) {
    const ensured = await ensureRunnerRunningFn({
      modelId: req.endpoint.model,
      fetchFn: doFetch,
    });
    // ACTIVE EVICTION / resource-ceiling: the machine is (still) too saturated to safely bring
    // the runner back up — very possibly the SAME pressure that just force-stopped it. Report a
    // PAUSED, resumable turn instead of attempting a request that can only fail against a dead
    // endpoint: the prompt is never lost, just deferred (see AiStreamResult.pausedReason's doc).
    if (ensured.reason === "resource-ceiling") {
      return {
        ok: true,
        paused: true,
        pausedReason: "resources-critical",
        text: "",
        toolCalls: [],
      };
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
  // Whether this request actually CARRIES tools. A tools-shaped rejection can only be read as
  // one if we sent tools in the first place — otherwise a provider that happens to say the word
  // for an unrelated reason would demote a perfectly capable endpoint.
  const sentTools = toWireTools(req.tools).length > 0;
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
        ...(sentTools ? { tools: toWireTools(req.tools) } : {}),
      },
    ),
    // Ollama extension, ignored elsewhere: keep the model resident so a multi-round agent
    // turn does not pay a cold reload per round. LOCAL only — a cloud endpoint never
    // receives a non-standard field. Recorded in `residentModels` so quitting gives the
    // RAM back rather than leaving it pinned for the next half hour.
    ...localKeepAliveField(locality),
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

  // (D) advisory only — see idle-watchdog.ts's header on why this doesn't block the request.
  const orphanRemainingMs = orphanGraceRemainingMs(req.endpoint.id);
  if (orphanRemainingMs > 0) {
    emit(sender, {
      runId: req.runId,
      kind: "status",
      text: `⚠ ${req.endpoint.id} may still be finishing a generation from an earlier paused turn — this request can queue behind it for up to ${Math.ceil(orphanRemainingMs / 1000)}s.`,
    });
  }

  /**
   * The abort controller and the idle watchdog, RE-ARMED per attempt.
   *
   * A controller is single-use and this one is also the cancel handle registered in
   * `inFlight`, so a retry has to replace it — otherwise attempt 2 aborts before it starts and
   * `ai:cancel` stops aborting the request that is actually running.
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
  // Hoisted to the TOP of every return path (not just the eventual success one): the renderer's
  // Model Health page can only ever learn about a breaker trip if a snapshot rides back on the
  // SAME turn that tripped it — a turn that fails never reaching this point left the page
  // permanently showing "closed" for an endpoint that was failing every single call.
  const breaker = endpointBreaker(req.endpoint.id);
  if (!pre.ok) {
    return {
      ok: false,
      error: pre.reason ?? "the request does not fit",
      text: "",
      toolCalls: [],
      breaker: breaker.snapshot(),
    };
  }

  let ac = new AbortController();
  /**
   * STABLE across every retry attempt (never reassigned) — this is what `ai:cancel` and the
   * idle watchdog actually act on, and what's threaded into `fetchModelWithRetry` below as
   * `userSignal` so `retry()`'s own abort checks (before each attempt, and right after a
   * failed one, `resilience/retry.ts:80,86`) see it regardless of whether a fetch is live or
   * the loop is in its backoff SLEEP between attempts. Before this, `inFlight` held whichever
   * per-attempt `ac` `armAttempt()` had most recently minted — during a sleep that was the
   * ALREADY-DEAD controller from the attempt that just failed, so a cancel or idle-fire
   * landing in that window aborted a controller nothing was listening to any more, and the
   * next attempt fired anyway, unaware.
   */
  const outerAc = new AbortController();
  inFlight.set(req.runId, outerAc);
  // propagate immediately to whichever per-attempt controller is CURRENTLY live, so an active
  // fetch is torn down right away rather than only ever stopping the NEXT attempt.
  outerAc.signal.addEventListener("abort", () => ac.abort(), { once: true });
  // set when THIS watchdog (not `ai:cancel`) ends the turn — a PAUSE, never a discard.
  const watchdog = new IdleWatchdog({
    idleTimeoutMs: req.idleTimeoutMs,
    onIdle: () => outerAc.abort(),
    ...(retryOpts.idleWatchdogNow ? { now: retryOpts.idleWatchdogNow } : {}),
    ...(retryOpts.idleWatchdogSetTimeout ? { setTimeoutFn: retryOpts.idleWatchdogSetTimeout } : {}),
    ...(retryOpts.idleWatchdogClearTimeout
      ? { clearTimeoutFn: retryOpts.idleWatchdogClearTimeout }
      : {}),
  });
  watchdog.arm();
  const armAttempt = (): AbortSignal => {
    ac = new AbortController();
    // a cancel/idle-fire that landed during the backoff sleep (before this attempt even
    // started) must still stop it from firing its own fetch.
    if (outerAc.signal.aborted) ac.abort();
    return ac.signal;
  };

  const requestAt = Date.now();
  // hoisted (not `const` at its point of assignment below) so a `paused` return from the
  // `catch` block — which can fire either before or after it's set — can always report it.
  let firstByteAt: number | undefined;
  let firstTokenAt: number | undefined;
  let text = "";
  let usage: AiStreamResult["usage"];
  const calls = newToolCallAccumulator();
  /**
   * Splits inline `<think>…</think>` out of the content stream.
   *
   * R1-style models put their thinking in ordinary content rather than in a `reasoning` field,
   * and a server that does not split it hands it straight through — so on those models the
   * deliberation arrived in the pane as the answer. The tag comes from the capability table
   * (`ai/effort/rules.ts`), resolved from the endpoint NAME here: `AiStreamRequest.endpoint`
   * carries no probe data, and every rule that names a `reasoningTag` matches on the model id
   * anyway (deepseek-r1, qwq, phi-4-reasoning, exaone-deep, qwen3).
   *
   * Independent of `req.effort`: these models leak the tag whether or not a tier was set.
   */
  const reasoningSplitter = ai.createReasoningTagSplitter(
    ai.resolveCapability({
      modelId: req.endpoint.model ?? req.endpoint.id,
      runtime: ai.runtimeFromBaseUrl(req.endpoint.baseUrl, localityOfUrl(req.endpoint.baseUrl)),
      locality: localityOfUrl(req.endpoint.baseUrl),
    }).cap.reasoningTag,
  );
  /** a provider failure reported mid-stream, after the 200 — see the wire's `error` event. */
  let streamError: string | undefined;
  // WHY the model stopped, when the provider says so; and whether it thought at all. Without
  // them a turn cut off at the context limit is indistinguishable from one with nothing to say.
  let stopReason: ai.WireEvent["stopReason"];
  let sawReasoning = false;

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
        return {
          ok: false,
          error: auth.reason,
          text: "",
          toolCalls: [],
          breaker: breaker.snapshot(),
        };
      }
      // The FORMAT decides the credential's shape: a bearer for OpenAI, `x-api-key` plus the
      // mandatory `anthropic-version` for Anthropic, `x-goog-api-key` for Gemini. A bearer
      // sent to the other two authenticates as nobody.
      if (auth.key) authHeader = wire.headers(auth.key);
    }

    // `breaker` (hoisted above, before `pre.ok`) rides back on the response — main is the only
    // process that actually holds this breaker instance, and the renderer folds its snapshot
    // into this endpoint's model-health record.
    let res: Awaited<ReturnType<typeof doFetch>>;
    try {
      // Explicit type argument: `doFetch as never` below (an existing cast, needed because the
      // injected fetch-like seam isn't exactly `typeof fetch`) means `R` can no longer be
      // inferred from `opts.doFetch` — it used to be inferred instead from the CONTEXTUAL type
      // of `res = await fetchModelWithRetry(...)`, which this `pending`-then-`raceTicks`
      // refactor no longer assigns directly.
      const pending = fetchModelWithRetry<Awaited<ReturnType<typeof doFetch>>>({
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
        // The STABLE controller — checked by `retry()` before each attempt AND right after a
        // failed one, which is what actually closes the backoff-sleep gap (see `outerAc`'s doc
        // comment above).
        userSignal: outerAc.signal,
        // …but only the CALLER's signal means "the human stopped it". An idle-watchdog abort
        // reaches `outerAc` too and must still count against the endpoint.
        // Here `outerAc` IS the user's controller (it is what `ai:cancel` aborts), and the
        // watchdog aborts the same one — so "was this the human?" is exactly "aborted, and
        // the watchdog did NOT fire". Without the discriminator a silent endpoint read as a
        // user cancel and never tripped the breaker.
        userAborted: () => outerAc.signal.aborted && !watchdog.didFire(),
        // Fail fast on a dead endpoint instead of paying the full retry schedule on every
        // subsequent round — see `endpointBreaker`.
        breaker,
        ...(retryOpts.sleep ? { sleep: retryOpts.sleep } : {}),
        ...(retryOpts.retries !== undefined ? { retries: retryOpts.retries } : {}),
        onRetry: (info) => {
          watchdog.touch();
          emit(sender, {
            runId: req.runId,
            kind: "status",
            text: `${info.reason} — retrying in ${Math.round(info.delayMs / 1000)}s`,
          });
        },
        ...(locality === "local" ? { onLocalActivity: touchModelActivity } : {}),
      });
      const ticker = raceTicks(pending, WATCHDOG_FIRST_TICK_MS, () => {
        const s = Math.round((Date.now() - requestAt) / 1000);
        return `⏳ still waiting for ${model} to start responding… (${s}s — a large local model can take 30–90s to start)`;
      });
      let step = await ticker.next();
      while (!step.done) {
        emit(sender, { runId: req.runId, kind: "status", text: step.value });
        step = await ticker.next();
      }
      res = step.value;
    } catch (err) {
      // An abort here (the idle watchdog firing before the first byte ever arrived — the
      // reported "~22-minute silent stall on a cold load" scenario, or a plain `ai:cancel`)
      // must reach the OUTER catch's `ac.signal.aborted && watchdog.didFire()` handling below,
      // not be swallowed here as a hard failure — this `return` used to do exactly that,
      // reporting a graceful pause/cancel as `{ok:false, error:"...cancelled"}` and defeating
      // the whole point of the idle-watchdog for precisely its most likely firing phase.
      if (ac.signal.aborted) throw err;
      // ACTIVE EVICTION: the connection attempt above never even reached the endpoint —
      // exactly what "Ollama was just force-stopped" looks like the moment the NEXT request
      // tries to use it (retries exhausted, still nothing listening). See the outer catch's
      // matching branch for the "already streaming when it died" case; this is the far more
      // common one, since a cold request after an eviction fails before ever connecting.
      if (
        locality === "local" &&
        findRecentEndpointEviction(
          req.endpoint.baseUrl,
          retryOpts.readEvictionEventsFn ?? readEvictionEvents,
        )
      ) {
        return {
          ok: true,
          paused: true,
          pausedReason: "resources-critical",
          text,
          toolCalls: [],
          breaker: breaker.snapshot(),
        };
      }
      /**
       * Was it refused BECAUSE it carried tools? Only this side can answer — the status and
       * the body both live here and neither survives the trip to the renderer as a string.
       * Reported, never acted on here: main does not choose transports. The renderer folds it
       * into its capability state and retries the SAME turn in the text protocol, exactly as
       * the agentic CLI has done since that protocol existed.
       */
      const toolsRejected =
        sentTools && err instanceof AiHttpError && looksLikeToolsRejection(err.status, err.detail);
      return {
        ok: false,
        error: `AI endpoint ${req.endpoint.id}: ${describeAiFailure(err)}`,
        text,
        toolCalls: [],
        ...(toolsRejected ? { toolsRejected: true } : {}),
        breaker: breaker.snapshot(),
      };
    }
    firstByteAt = Date.now();
    if (!res.body) {
      return {
        ok: false,
        error: `AI endpoint ${req.endpoint.id}: empty body`,
        text,
        toolCalls: [],
        breaker: breaker.snapshot(),
      };
    }

    /**
     * A 200 that is NOT an SSE stream is still an answer.
     *
     * Plenty of OpenAI-compatible servers, proxies and gateways ignore `stream: true` and reply
     * with an ordinary JSON completion. The reader below looks only for `data:` lines, finds
     * none, and the turn ends with no text, no usage and no error — a completely silent reply,
     * indistinguishable to the user from the model declining. Core's shared client was fixed the
     * same way; this transport is the desktop's own copy and had the identical hole.
     */
    const contentType = res.headers?.get?.("content-type") ?? "";
    if (contentType && !/text\/event-stream/i.test(contentType)) {
      const whole = await res.text();
      const ev = wire.parseWhole(whole);
      if (ev.error !== undefined) {
        return {
          ok: false,
          error: `AI endpoint ${req.endpoint.id}: ${ev.error}`,
          text,
          toolCalls: [],
          breaker: breaker.snapshot(),
        };
      }
      if (ev.usage) usage = ai.mergeWireUsage(usage, ev.usage);
      if (ev.delta) {
        text += ev.delta;
        emit(sender, { runId: req.runId, kind: "text", text: ev.delta });
        return {
          ok: true,
          text,
          toolCalls: [],
          ...(usage ? { usage } : {}),
          breaker: breaker.snapshot(),
        };
      }
      return {
        ok: false,
        error: `AI endpoint ${req.endpoint.id} answered 200 with ${contentType || "an unknown content type"} and no readable content`,
        text,
        toolCalls: [],
        breaker: breaker.snapshot(),
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
        const ticker = raceTicks(
          pendingRead,
          firstByte ? WATCHDOG_STREAM_TICK_MS : WATCHDOG_FIRST_TICK_MS,
          () => {
            const s = Math.round((Date.now() - requestAt) / 1000);
            return firstByte
              ? `▼ ${model} still generating… (${s}s)`
              : `⏳ waiting for ${model} — no output yet (${s}s). A large local model can take 30–90s to start.`;
          },
        );
        let tickStep = await ticker.next();
        while (!tickStep.done) {
          emit(sender, { runId: req.runId, kind: "status", text: tickStep.value });
          tickStep = await ticker.next();
        }
        const { value, done: streamDone } = tickStep.value;
        if (streamDone) break;
        watchdog.touch();
        firstByte = true;
        clearPossibleOrphan(req.endpoint.id);
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
          if (ev.stopReason) stopReason = ev.stopReason;
          if (ev.usage) usage = ai.mergeWireUsage(usage, ev.usage);
          const thinking = reasoningFrom(payload);
          if (thinking) {
            sawReasoning = true;
            emit(sender, { runId: req.runId, kind: "reasoning", text: thinking });
          }
          if (ev.delta) {
            // the FIRST content delta is where generation actually starts; everything
            // before it is load, however the runner spent it.
            firstTokenAt ??= Date.now();
            const split = reasoningSplitter.push(ev.delta);
            if (split.reasoning) {
              sawReasoning = true;
              emit(sender, { runId: req.runId, kind: "reasoning", text: split.reasoning });
            }
            if (split.text) {
              // `text` is the AUTHORITATIVE answer the invoke returns, so the thinking has to
              // be kept out of it here and not merely hidden in the presentational feed.
              text += split.text;
              emit(sender, { runId: req.runId, kind: "text", text: split.text });
            }
          }
          // EVERY call in the frame — a provider may batch a turn's parallel calls into one,
          // and reading only `ev.toolCall` executed the first and silently dropped the rest.
          for (const tc of ev.toolCalls ?? (ev.toolCall ? [ev.toolCall] : [])) {
            accumulateCall(calls, tc);
          }
        }
        if (!done) pendingRead = reader.read();
      }
      // An unterminated `<think>` flushes as REASONING, never into `text`: a model cut off
      // mid-thought was still thinking.
      const tail = reasoningSplitter.end();
      if (tail.reasoning)
        emit(sender, { runId: req.runId, kind: "reasoning", text: tail.reasoning });
      if (tail.text) {
        text += tail.text;
        emit(sender, { runId: req.runId, kind: "text", text: tail.text });
      }
      /**
       * A turn that produced NOTHING, or was cut off mid-answer, says so.
       *
       * The pane appends nothing for an empty answer (`commitStreaming` short-circuits on an
       * empty buffer), so a model that spent its whole remaining window on reasoning left the
       * transcript untouched — no answer, no error, nothing to act on.
       */
      if (!streamError && harvestCalls(calls).length === 0) {
        const budget = {
          ...(stopReason ? { stopReason } : {}),
          promptTokens:
            usage?.inputTokens ?? ai.estimateRequestTokens(req.messages.map((m) => m.content)),
          contextWindow: req.endpoint.contextWindow,
          runtime: ai.runtimeFromBaseUrl(req.endpoint.baseUrl, locality),
        };
        const notice =
          text.trim() === ""
            ? ai.emptyTurnNotice({ ...budget, sawReasoning })
            : stopReason === "length"
              ? `\n\n${ai.truncationNotice(budget)}`
              : "";
        if (notice) {
          text += notice;
          emit(sender, { runId: req.runId, kind: "text", text: notice });
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    if (streamError) {
      return { ok: false, error: streamError, text, toolCalls: [], breaker: breaker.snapshot() };
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
      toolCalls: harvestCalls(calls),
      ...(usage ? { usage } : {}),
      timing: {
        requestAt,
        firstByteAt,
        ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
        lastByteAt: Date.now(),
      },
      breaker: breaker.snapshot(),
    };
  } catch (e) {
    // An abort is a USER action (stop / re-prompt) or our own idle watchdog, not a failure to
    // report as an error string the pane would paint red.
    if (ac.signal.aborted) {
      // Was it OUR idle watchdog, or `ai:cancel`/a superseded run? Only the FORMER is `paused`
      // — the latter stays the existing "quiet, ok:true" shape.
      if (watchdog.didFire()) {
        markPossibleOrphan(req.endpoint.id); // (D)
        return {
          ok: true,
          paused: true,
          pausedReason: "idle",
          text,
          /**
           * NOT `[]`.
           *
           * `text` was preserved here from the start and `toolCalls` was hardcoded empty beside
           * it, so a turn that had already streamed a COMPLETE native tool call reported the
           * prose and silently dropped the call — while the pause line told the user no work
           * was lost. `completeOnly` is the safety half: a stream cut mid-arguments leaves
           * unparseable JSON, and handing that on would parse to `{}` and run the tool with no
           * arguments at all, which is worse than dropping it.
           */
          toolCalls: harvestCalls(calls, { completeOnly: true }),
          timing: {
            requestAt,
            ...(firstByteAt !== undefined ? { firstByteAt } : {}),
            ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
            lastByteAt: Date.now(),
          },
          breaker: breaker.snapshot(),
        };
      }
      return { ok: true, text, toolCalls: [], breaker: breaker.snapshot() };
    }
    // ACTIVE EVICTION, mid-request: a real connection failure (not an abort) against a LOCAL
    // endpoint whose runner was JUST force-stopped under critical RAM pressure — the request
    // above ran the ensureOllamaRunning autostart check BEFORE it started, so this only catches
    // the (rarer) case of an eviction landing WHILE this exact request was already in flight.
    // Reads very differently from an ordinary "the daemon was never running" failure: the
    // prompt was interrupted BY Prometheus protecting the machine, not by a config problem, and
    // deserves the same resumable "paused" treatment as an idle pause, not a red error.
    if (
      locality === "local" &&
      findRecentEndpointEviction(
        req.endpoint.baseUrl,
        retryOpts.readEvictionEventsFn ?? readEvictionEvents,
      )
    ) {
      return {
        ok: true,
        paused: true,
        pausedReason: "resources-critical",
        text,
        toolCalls: harvestCalls(calls, { completeOnly: true }),
        breaker: breaker.snapshot(),
      };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      text,
      toolCalls: [],
      breaker: breaker.snapshot(),
    };
  } finally {
    watchdog.dispose();
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

/**
 * Measure ONE local model — its real context window AND the runner's capability array.
 *
 * Thin wrapper over core's `probeContextWindow`, which the CLI hosts have used since it
 * existed; Studio had no path to it at all, so every desktop endpoint ran on the 8192 floor and
 * the effort chip had no capability data to resolve against. See `AiProbeEndpointResult`.
 *
 * `doFetch` is injectable for the same reason `probeServedModels`'s is: the parse/fail-soft
 * logic must be testable without Electron.
 */
/**
 * Successful probes, keyed `baseUrl\u0000model`.
 *
 * FOUR components call `useActiveEndpoint` (AgentPane, two EditorPane surfaces, DatabasePanel)
 * and each keeps its own hook state, so every model switch fired four identical `/api/show`
 * POSTs at the runner. The CLI never had this problem because its probe owns a cache
 * (`ai/endpoint-probe.ts`); main had none, so the cache belongs here — at the one place all
 * four requests funnel through.
 *
 * FAILURES ARE NOT CACHED, deliberately and for the same reason core does not cache them: a
 * runner that was still starting up when the window opened has to be re-askable.
 */
const probeCache = new Map<string, { result: AiProbeEndpointResult; atMs: number }>();

/**
 * Probes currently in flight, same key.
 *
 * The cache alone is not enough, and the case it misses is the ONLY one that actually happens:
 * the four panes mount together, so all four calls arrive before any of them has resolved, all
 * four miss, and all four go to the runner. De-duplicating in flight is what turns four
 * requests into one — the cache handles the later switches back.
 */
const probeInFlight = new Map<string, Promise<AiProbeEndpointResult>>();

/** Test seam: how many live probes have actually gone out. */
export function probeRequestCount(): number {
  return probeCalls;
}
let probeCalls = 0;

/** Drop the cache — for tests, and for a future "the user re-pulled a model" signal. */
export function resetProbeCache(): void {
  probeCache.clear();
  probeInFlight.clear();
  probeCalls = 0;
}

export async function probeEndpointCapabilities(
  baseUrl: string,
  model: string,
  doFetch: typeof fetch = fetch,
): Promise<AiProbeEndpointResult> {
  const key = `${baseUrl.replace(/\/+$/, "")}\u0000${model}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.atMs < PROBE_CACHE_TTL_MS) return hit.result;
  const pending = probeInFlight.get(key);
  if (pending) return pending;
  const run = probeOnce(key, baseUrl, model, doFetch).finally(() => probeInFlight.delete(key));
  probeInFlight.set(key, run);
  return run;
}

async function probeOnce(
  key: string,
  baseUrl: string,
  model: string,
  doFetch: typeof fetch,
): Promise<AiProbeEndpointResult> {
  probeCalls += 1;
  try {
    const r = await probeContextWindow(baseUrl, model, doFetch as never);
    const result: AiProbeEndpointResult = {
      ok: true,
      contextWindow: r.contextWindow,
      source: r.source,
      ...(r.capabilities ? { capabilities: [...r.capabilities] } : {}),
      ...(r.revision ? { revision: r.revision } : {}),
    };
    if (r.source !== "default") probeCache.set(key, { result, atMs: Date.now() });
    return result;
  } catch {
    // `probeContextWindow` swallows its own errors and returns `source:"default"`; this is the
    // belt-and-braces path for a `fetch` that rejects before it ever gets there.
    return { ok: true, contextWindow: 0, source: "default" };
  }
}

/** Register `ai:stream` / `ai:cancel` / `ai:probeModels` / `ai:probeEndpoint` on the caller's
 *  `ipcMain`. */
export function registerAiIpc(ipc: IpcMain): void {
  ipc.handle(IPC.aiStream, async (evt: unknown, arg: unknown): Promise<AiStreamResult> => {
    const req = arg as AiStreamRequest;
    if (!req || typeof req.runId !== "string" || !req.endpoint?.baseUrl) {
      return { ok: false, error: "ai:stream: malformed request", text: "", toolCalls: [] };
    }
    const sender = (evt as { sender?: WebContents } | undefined)?.sender;
    return runAiStream(req, sender, undefined, undefined, {
      ensureOllamaRunningFn: ai.ensureOllamaRunning,
      ensureLmStudioRunningFn: ai.ensureLmStudioRunning,
    });
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
      // LOCAL ONLY — the same rule its sibling `ai:probeEndpoint` states one handler below,
      // and it was missing here. `GET {baseUrl}/models` at a cloud provider is unsolicited
      // egress: it announces this installation to a third party without the user asking for
      // inference, and the renderer chooses the URL. No key is attached, so this is a
      // telemetry leak rather than a credential one — which is exactly why it went unnoticed.
      if (localityOfUrl(baseUrl) !== "local") {
        return { ok: false, models: [], error: "ai:probeModels: refused — probing is local-only" };
      }
      return probeServedModels(baseUrl);
    },
  );

  ipc.handle(
    IPC.aiProbeEndpoint,
    async (_evt: unknown, arg: unknown): Promise<AiProbeEndpointResult> => {
      const req = arg as { baseUrl?: unknown; model?: unknown } | null;
      const baseUrl = req?.baseUrl;
      const model = req?.model;
      if (typeof baseUrl !== "string" || baseUrl.length === 0) {
        return {
          ok: false,
          contextWindow: 0,
          source: "default",
          error: "ai:probeEndpoint: malformed request",
        };
      }
      if (typeof model !== "string" || model.length === 0) {
        return {
          ok: false,
          contextWindow: 0,
          source: "default",
          error: "ai:probeEndpoint: malformed request",
        };
      }
      // LOCAL ONLY, enforced HERE and not merely in the renderer that asked: `/api/show` is an
      // Ollama endpoint, and firing an unknown POST at a cloud provider to satisfy curiosity is
      // not something a privacy-first client does. Same rule core's `probeContextWindow`
      // documents; this is the process that can actually hold the line on it (§7.5).
      if (localityOfUrl(baseUrl) !== "local") {
        return {
          ok: false,
          contextWindow: 0,
          source: "default",
          error: "ai:probeEndpoint: refused — probing is local-only",
        };
      }
      return probeEndpointCapabilities(baseUrl, model);
    },
  );
}
