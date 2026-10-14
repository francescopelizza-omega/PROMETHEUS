// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/free-rotation.ts — the "endless free model": one endpoint backed by every free LLM API the
 * user can reach, rotating to the next when one runs out of quota.
 *
 * WHERE IT PLUGS IN. Not in a transport. Prometheus has four of them (core's `createAiClient`,
 * the CLI's native tool turn, the desktop main process, the VS Code extension), and each one
 * already does the hard parts — retries, idle watchdogs, SSE parsing, tool-call reassembly. They
 * all send through one seam, a `FetchLike`. So the rotation is a FETCH: the session adopts an
 * endpoint whose base URL is `ROTATION_BASE_URL`, and `createRotatingFetch` turns each request to
 * it into a request to a real member — its URL, its key, its model id — before a byte is sent.
 * Every transport gets failover by wrapping one function, and none of them learns a new concept.
 *
 * THE BASE URL FAILS CLOSED. `.invalid` is reserved (RFC 6761) and can never resolve. A host
 * that adopts the rotation endpoint but forgets to wrap its fetch does not leak a prompt to some
 * default — the request dies in DNS with an error naming the problem.
 *
 * WHEN IT ROTATES. Only before the first byte of a response, which is the same boundary the
 * retry layer draws (`ai/request.ts`): once a stream is being read, the user has seen tokens, and
 * replaying the turn on another model would show them a different answer spliced onto the first.
 * A member that answers 401/402/403/404/408/409/413/422/429/5xx — or does not answer at all —
 * is put on a cooldown and the same request goes to the next member immediately. Only when every
 * member is cooling does the caller see a 429, carrying `Retry-After` for the soonest recovery,
 * so the existing retry layer either waits for it or says how long it would be.
 *
 * WHAT IT NEVER DOES. It never opens a second account at a provider and never sends one key to
 * another provider: one member = one provider's own key (or that provider's anonymous tier).
 * It never rotates onto a provider the user did not give a key to, except the explicitly keyless
 * tiers in `model-catalog/free-tier.ts`.
 */
import { API_PROVIDERS, type ApiProvider, resolveApiKey } from "../orchestration/api-providers.js";
import type { AiEndpoint, FetchLike, KeyResolver } from "./client.js";
import { CLOUD_MODELS } from "./model-catalog/cloud.js";
import { FREE_TIERS } from "./model-catalog/free-tier.js";
import type { CloudModelEntry, FreeTierInfo } from "./model-catalog/types.js";

/** The rotation endpoint's base URL — reserved TLD, so an unwrapped fetch cannot leak. */
export const ROTATION_BASE_URL = "https://free-rotation.prometheus.invalid/v1";
export const ROTATION_ENDPOINT_ID = "cloud:rotation:free";
export const ROTATION_MODEL = "free-rotation";

/**
 * A member below this window is left out entirely. Prometheus's own prompt is ~7.2K tokens of
 * system text and tool schemas before the user types, so a member that cannot hold a modest
 * agent turn would only ever be skipped by `fitsWindow` — listing it would be noise.
 */
export const MIN_MEMBER_CONTEXT = 32_768;

export interface RotationMember {
  /** `${providerId}:${model}` — unique within a rotation. */
  id: string;
  providerId: string;
  /** human label, for notices. */
  label: string;
  /** OpenAI-compatible base URL. */
  baseUrl: string;
  model: string;
  /** keychain/env ref; absent for a keyless tier. */
  apiKeyRef?: string;
  contextWindow: number;
}

/* ------------------------------------------------------------------------- *
 * Building the member list
 * ------------------------------------------------------------------------- */

export interface RotationMemberOpts {
  env: Record<string, string | undefined>;
  /** whether the OS keychain holds `provider:<id>` — injected so this stays pure. */
  hasKeychainKey?: (providerId: string) => boolean;
  /** leave out providers whose free tier may train on prompts. Default false (keep them). */
  excludeTraining?: boolean;
  /** leave out the anonymous tiers. Default false. */
  excludeKeyless?: boolean;
  /** provider ids the user switched off. */
  exclude?: readonly string[];
  providers?: readonly ApiProvider[];
  tiers?: readonly FreeTierInfo[];
  models?: readonly CloudModelEntry[];
}

/** Where a provider's key lives, as a ref — or undefined when there is none. */
function keyRefFor(
  p: ApiProvider,
  env: Record<string, string | undefined>,
  hasKeychainKey?: (providerId: string) => boolean,
): string | undefined {
  const fromEnv = resolveApiKey(p.id, env);
  if (fromEnv) return `env:${fromEnv.env}`;
  if (hasKeychainKey?.(p.id)) return `keychain:provider:${p.id}`;
  return undefined;
}

/**
 * Every member this machine can use right now, in rotation order (the tier's `priority`, then
 * catalogue order within a provider).
 */
export function rotationMembers(opts: RotationMemberOpts): RotationMember[] {
  const providers = new Map((opts.providers ?? API_PROVIDERS).map((p) => [p.id, p]));
  const tiers = opts.tiers ?? FREE_TIERS;
  const models = opts.models ?? CLOUD_MODELS;
  const excluded = new Set(opts.exclude ?? []);
  const out: { member: RotationMember; priority: number; order: number }[] = [];
  let order = 0;
  for (const entry of models) {
    order += 1;
    if (entry.section !== "free" || !entry.rotation || !entry.tools) continue;
    if (excluded.has(entry.providerId)) continue;
    const p = providers.get(entry.providerId);
    const tier = tiers.find((t) => t.providerId === entry.providerId);
    if (!p || !tier || tier.kind !== "renewing") continue;
    if (opts.excludeTraining && tier.dataUse === "may-train") continue;
    const ref = keyRefFor(p, opts.env, opts.hasKeychainKey);
    if (!ref && (!tier.keyless || opts.excludeKeyless)) continue;
    const contextWindow = entry.contextWindow ?? p.contextWindow ?? 0;
    if (contextWindow < MIN_MEMBER_CONTEXT) continue;
    out.push({
      member: {
        id: `${p.id}:${entry.model}`,
        providerId: p.id,
        label: entry.label,
        baseUrl: tier.rotationBaseUrl ?? p.baseUrl,
        model: entry.model,
        ...(ref ? { apiKeyRef: ref } : {}),
        contextWindow,
      },
      priority: tier.priority,
      order,
    });
  }
  return out.sort((a, b) => a.priority - b.priority || a.order - b.order).map((x) => x.member);
}

/**
 * The one endpoint a session adopts. `null` when no member is usable.
 *
 * Its window is the LARGEST member's: the rotating fetch routes each request only to members
 * whose own window holds it (`fitsWindow`), so a long prompt goes to a long-context member
 * instead of being refused because the smallest member could not take it.
 */
export function rotationEndpoint(members: readonly RotationMember[]): AiEndpoint | null {
  if (members.length === 0) return null;
  return {
    id: ROTATION_ENDPOINT_ID,
    baseUrl: ROTATION_BASE_URL,
    locality: "cloud",
    model: ROTATION_MODEL,
    contextWindow: Math.max(...members.map((m) => m.contextWindow)),
    contextWindowMeasured: true,
    supportsTools: true,
    rotation: members,
  };
}

/** Rough prompt size of a request body: chars/4, the same estimate compaction budgets with. */
function estimatedTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

/** Does this request fit the member's window, leaving room for a reply? */
export function fitsWindow(member: RotationMember, body: string): boolean {
  return estimatedTokens(body) * 1.15 + 1024 <= member.contextWindow;
}

export function isRotationUrl(url: string): boolean {
  return url.toLowerCase().startsWith(ROTATION_BASE_URL);
}

export function isRotationEndpoint(e: Pick<AiEndpoint, "baseUrl">): boolean {
  return isRotationUrl(e.baseUrl);
}

/* ------------------------------------------------------------------------- *
 * Cooldown state
 * ------------------------------------------------------------------------- */

/** Why a member is benched — it decides how long, and whether it may be retried early. */
type CoolKind = "rate" | "account" | "request" | "gone" | "transient";

interface MemberState {
  /** epoch ms until which the member is skipped. */
  until: number;
  /** consecutive rate-limit answers — each doubles the next cooldown. */
  strikes: number;
  /** consecutive request-shaped refusals (400/403/413/422) — benched only after several. */
  badRequests?: number;
  kind?: CoolKind;
  lastReason?: string;
}

export interface RotationState {
  members: Map<string, MemberState>;
  /** the member that served the last successful request. */
  lastServed?: string | undefined;
}

export function createRotationState(): RotationState {
  return { members: new Map() };
}

/** The process-wide state every wrapped fetch shares unless a test injects its own. */
const DEFAULT_STATE = createRotationState();

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * How long to leave a member alone after this answer.
 *
 * A 429's `Retry-After` is the provider telling us exactly; otherwise rate limits escalate
 * (1, 2, 4 … 60 minutes) so a member whose DAILY quota is gone costs one wasted request an hour
 * rather than one a minute. A refused key or exhausted credit (401/402) does not fix itself in a
 * minute; a missing model (404) is a stale catalogue row. A request-shaped refusal (400/403/413/
 * 422) is usually about THIS prompt — too long for that member, a schema it rejects, a moderation
 * flag — so it only benches a member after `BAD_REQUEST_STRIKES` in a row (see the fetch).
 */
export function cooldownMs(
  status: number,
  retryAfterMs: number | undefined,
  strikes: number,
): number {
  if (status === 429) {
    if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, 24 * HOUR);
    return Math.min(MINUTE * 2 ** Math.max(0, strikes - 1), HOUR);
  }
  if (status === 401 || status === 402) return HOUR;
  if (status === 404) return 6 * HOUR;
  if (status === 400 || status === 403 || status === 413 || status === 422) return 10 * MINUTE;
  return 15 * SECOND; // 408/409/425/5xx/network/timeout: transient
}

/** Request-shaped refusals in a row before a member is benched for `cooldownMs`. */
export const BAD_REQUEST_STRIKES = 3;

/** How long a member may take to send response HEADERS before the next member is tried. */
export const MEMBER_HEADER_TIMEOUT_MS = 45_000;

/** Statuses that mean "this member cannot serve this request now" — try the next one. */
export function isRotatableStatus(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 413 ||
    status === 422 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

/** Parse `Retry-After` (seconds or HTTP date) into ms from `now`. */
function retryAfterMs(raw: string | null | undefined, now: number): number | undefined {
  if (!raw) return undefined;
  const secs = Number(raw.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * SECOND);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export interface RotationMemberStatus {
  member: RotationMember;
  ready: boolean;
  /** ms until it is tried again, when cooling. */
  coolingForMs?: number;
  lastReason?: string;
  serving: boolean;
}

/** A snapshot for `/models status` and the desktop panel. */
export function rotationStatus(
  members: readonly RotationMember[],
  state: RotationState = DEFAULT_STATE,
  now: number = Date.now(),
): RotationMemberStatus[] {
  return members.map((member) => {
    const s = state.members.get(member.id);
    const cooling = s !== undefined && s.until > now;
    return {
      member,
      ready: !cooling,
      ...(cooling ? { coolingForMs: s.until - now } : {}),
      ...(s?.lastReason ? { lastReason: s.lastReason } : {}),
      serving: state.lastServed === member.id,
    };
  });
}

/** Forget every cooldown (the user added a key, or asked to retry everything now). */
export function resetRotation(state: RotationState = DEFAULT_STATE): void {
  state.members.clear();
  state.lastServed = undefined;
}

/* ------------------------------------------------------------------------- *
 * Notices
 * ------------------------------------------------------------------------- */

export interface RotationEvent {
  from?: RotationMember;
  to: RotationMember;
  /** why `from` was left, e.g. "429 rate-limited". */
  reason?: string;
}

const listeners = new Set<(e: RotationEvent) => void>();

/**
 * Subscribe to "the rotation moved to another member". Returns the unsubscribe.
 *
 * A host prints it: a silent switch from a 120B model to a 70B one would read as the model
 * suddenly getting worse, with no way for the user to know why.
 */
export function onRotationEvent(listener: (e: RotationEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(e: RotationEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      // a broken listener must not break a request
    }
  }
}

/* ------------------------------------------------------------------------- *
 * The fetch
 * ------------------------------------------------------------------------- */

export interface RotatingFetchOpts {
  members: readonly RotationMember[];
  resolveKey?: KeyResolver;
  state?: RotationState;
  now?: () => number;
  /**
   * Switches made by THIS fetch, and only this one. The process-wide `onRotationEvent` hears
   * every wrapped fetch, which is right for a CLI session (one conversation per process) and
   * wrong for the desktop, where two panes can stream at once and would announce each other's
   * switches into the wrong conversation.
   */
  onEvent?: (e: RotationEvent) => void;
  /** override `MEMBER_HEADER_TIMEOUT_MS` (tests). */
  headerTimeoutMs?: number;
}

type FetchResult = Awaited<ReturnType<FetchLike>>;

function describeStatus(status: number): string {
  if (status === 429) return "429 rate-limited / quota used up";
  if (status === 401 || status === 403) return `${status} key refused`;
  if (status === 402) return "402 free credit used up";
  if (status === 404) return "404 model not served any more";
  if (status >= 500) return `${status} provider error`;
  return `${status} refused the request`;
}

/** Swap the `model` field of a JSON body; leave anything unparseable untouched. */
function withModel(body: string, model: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, model });
    }
  } catch {
    // not JSON — not ours to rewrite
  }
  return body;
}

function withAuth(
  headers: Record<string, string>,
  key: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "authorization") out[k] = v;
  }
  if (key) out.authorization = `Bearer ${key}`;
  return out;
}

function joinBase(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

/** A response for "every member is cooling" — shaped like a provider's 429. */
function allCoolingResponse(waitMs: number, members: readonly RotationMember[]): FetchResult {
  const secs = Math.max(1, Math.ceil(waitMs / SECOND));
  const text = `every free provider in the rotation is rate-limited or refused this request (${members.length} tried); the soonest frees up in about ${secs}s`;
  return {
    ok: false,
    status: 429,
    statusText: "All free providers exhausted",
    body: null,
    text: async () => text,
    headers: {
      get: (name: string) => (name.toLowerCase() === "retry-after" ? String(secs) : null),
    },
  };
}

async function discard(res: FetchResult | undefined): Promise<void> {
  try {
    await res?.body?.cancel();
  } catch {
    // already closed
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

/**
 * Wrap `base` so requests to `ROTATION_BASE_URL` go to the first member that can serve them.
 * Every other URL passes straight through, so wrapping a host's fetch once is always safe.
 */
export function createRotatingFetch(base: FetchLike, opts: RotatingFetchOpts): FetchLike {
  const state = opts.state ?? DEFAULT_STATE;
  const now = opts.now ?? Date.now;
  const cooling = (m: RotationMember, t: number): boolean =>
    (state.members.get(m.id)?.until ?? 0) > t;
  return async (input, init) => {
    if (!isRotationUrl(input)) return base(input, init);
    const suffix = input.slice(ROTATION_BASE_URL.length);
    const t = now();
    let ready = opts.members.filter((m) => !cooling(m, t));
    if (ready.length === 0) {
      // Every member is benched. A TRANSIENT bench (a 5xx, a dropped connection) is a guess
      // that the blip lasts a few seconds — not grounds to refuse the user outright when a plain
      // retry would very likely succeed, so those members are tried anyway, soonest first.
      ready = opts.members
        .filter((m) => state.members.get(m.id)?.kind === "transient")
        .sort(
          (a, b) => (state.members.get(a.id)?.until ?? 0) - (state.members.get(b.id)?.until ?? 0),
        );
    }
    if (ready.length === 0) {
      const soonest = Math.min(...opts.members.map((m) => state.members.get(m.id)?.until ?? t));
      return allCoolingResponse(soonest - t, opts.members);
    }
    // Long prompts go to members that can hold them; if none can, try the biggest anyway and
    // let the provider be the judge (our estimate is chars/4, not its tokenizer).
    const fitting = ready.filter((m) => fitsWindow(m, init.body));
    const order =
      fitting.length > 0 ? fitting : [...ready].sort((a, b) => b.contextWindow - a.contextWindow);
    const previous = opts.members.find((m) => m.id === state.lastServed);
    let lastRes: FetchResult | undefined;
    let lastErr: unknown;
    let leftReason: string | undefined;
    for (const m of order) {
      if (init.signal?.aborted) break;
      // An account-wide refusal earlier in THIS request already benched this member.
      if (cooling(m, now()) && state.members.get(m.id)?.kind !== "transient") continue;
      const bench = (
        kind: CoolKind,
        ms: number,
        reason: string,
        members: readonly RotationMember[] = [m],
      ): void => {
        for (const other of members) {
          const prev = state.members.get(other.id);
          state.members.set(other.id, {
            until: now() + ms,
            strikes: kind === "rate" ? (prev?.strikes ?? 0) + 1 : 0,
            kind,
            lastReason: reason,
          });
        }
        if (m.id === state.lastServed) leftReason = reason;
      };
      const classify = (status: number, after?: number): void => {
        const reason = describeStatus(status);
        const prev = state.members.get(m.id);
        if (status === 429) {
          bench("rate", cooldownMs(429, after, (prev?.strikes ?? 0) + 1), reason);
        } else if (status === 401 || status === 402) {
          // A refused KEY or exhausted credit is the provider's verdict on the ACCOUNT: every
          // member of that provider is equally refused, and trying each would spend a request
          // per model to learn the same thing.
          bench(
            "account",
            cooldownMs(status, undefined, 0),
            reason,
            opts.members.filter((x) => x.providerId === m.providerId),
          );
        } else if (status === 404) {
          bench("gone", cooldownMs(404, undefined, 0), reason);
        } else if (status === 400 || status === 403 || status === 413 || status === 422) {
          // Usually about THIS prompt. Skip the member for this request; bench it only when it
          // keeps refusing (an incompatible parameter, a model whose terms were never accepted).
          const n = (prev?.badRequests ?? 0) + 1;
          if (n >= BAD_REQUEST_STRIKES) bench("request", cooldownMs(status, undefined, 0), reason);
          else
            state.members.set(m.id, {
              until: prev?.until ?? 0,
              strikes: prev?.strikes ?? 0,
              badRequests: n,
              ...(prev?.kind ? { kind: prev.kind } : {}),
              lastReason: reason,
            });
          if (m.id === state.lastServed) leftReason = reason;
        } else {
          bench("transient", cooldownMs(status, undefined, 0), reason);
        }
      };
      let key: string | undefined;
      if (m.apiKeyRef) {
        try {
          key = await (opts.resolveKey ?? (async () => ""))(m.apiKeyRef);
        } catch {
          key = undefined;
        }
        if (!key) {
          // Short: a locked keychain unlocks, and a key added later should be picked up soon.
          bench("transient", 30 * SECOND, "no key available");
          continue;
        }
      }
      // Our own controller per attempt: the caller's abort still reaches it, and a member that
      // accepts the connection but never answers is abandoned after MEMBER_HEADER_TIMEOUT_MS —
      // otherwise the idle watchdog aborts the whole request and the retry lands on the same
      // hung member, every turn. The timer is cleared the moment headers arrive, so it never
      // touches a stream that is already flowing.
      const ac = new AbortController();
      const onCallerAbort = (): void => ac.abort();
      if (init.signal) {
        if (init.signal.aborted) ac.abort();
        else init.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, opts.headerTimeoutMs ?? MEMBER_HEADER_TIMEOUT_MS);
      // Kept on success: the caller's abort must still reach the stream being read.
      const release = (): void => init.signal?.removeEventListener("abort", onCallerAbort);
      let res: FetchResult;
      try {
        res = await base(joinBase(m.baseUrl, suffix), {
          ...init,
          headers: withAuth(init.headers, key),
          body: withModel(init.body, m.model),
          signal: ac.signal,
        });
      } catch (e) {
        release();
        if (!timedOut && (isAbortError(e) || init.signal?.aborted)) throw e;
        bench(
          "transient",
          cooldownMs(0, undefined, 0),
          timedOut
            ? "no answer in time"
            : `unreachable (${e instanceof Error ? e.message : String(e)})`,
        );
        lastErr = e;
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        await discard(lastRes);
        if (state.members.has(m.id)) state.members.set(m.id, { until: 0, strikes: 0 });
        if (state.lastServed !== m.id) {
          const ev: RotationEvent = {
            ...(previous ? { from: previous } : {}),
            to: m,
            ...(leftReason ? { reason: leftReason } : {}),
          };
          emit(ev);
          try {
            opts.onEvent?.(ev);
          } catch {
            // a broken listener must not break a request
          }
        }
        state.lastServed = m.id;
        return res;
      }
      if (!isRotatableStatus(res.status)) {
        await discard(lastRes);
        return res;
      }
      release();
      classify(res.status, retryAfterMs(res.headers?.get("retry-after"), now()));
      await discard(lastRes);
      lastRes = res;
    }
    if (lastRes) return lastRes;
    if (lastErr !== undefined) throw lastErr;
    if (init.signal?.aborted) {
      const e = new Error("the request was aborted");
      e.name = "AbortError";
      throw e;
    }
    // Every ready member lacked a key.
    const t2 = now();
    const soonest = Math.min(...opts.members.map((m) => state.members.get(m.id)?.until ?? t2));
    return allCoolingResponse(Math.max(SECOND, soonest - t2), opts.members);
  };
}

/** The fetch a transport should use for `endpoint`: rotating when it is the rotation. */
export function fetchForEndpoint(
  endpoint: Pick<AiEndpoint, "baseUrl" | "rotation">,
  base: FetchLike,
  resolveKey?: KeyResolver,
): FetchLike {
  if (!endpoint.rotation || endpoint.rotation.length === 0) return base;
  return createRotatingFetch(base, {
    members: endpoint.rotation,
    ...(resolveKey ? { resolveKey } : {}),
  });
}
