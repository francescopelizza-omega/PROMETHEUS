// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/endpoint-probe.ts — keep a measured endpoint measured, across every rebind.
 *
 * `probeContextWindow` has always been able to answer two questions in one round trip: how big
 * is this model's context, and what can it DO (`/api/show`'s `capabilities`, which is the only
 * thing that makes `/think` work on a locally-served model — see `ai/effort/rules.ts`, where the
 * probe-driven rules outrank every name guess). Both hosts asked it exactly once, at session
 * start, for the endpoint that happened to be active then.
 *
 * That is the bug this module exists to close. `/model`, `/worker` and `/setup` all rebind the
 * session endpoint to a FRESHLY BUILT object (`session/model-candidates.ts` hard-codes
 * `contextWindow: DEFAULT_CONTEXT_WINDOW` and carries no `probedCapabilities` at all), and
 * nothing re-probed. So switching model silently threw away both measurements: compaction went
 * back to budgeting a 262144-window model at 8192, and `/think` went back to reporting
 * "not available" for models that had just told us, in as many words, that they can think.
 *
 * The fix is one seam every rebind site goes through. It is deliberately NOT a free function:
 * a cache with no owner is a global, and a global cache in a module that four surfaces import
 * cannot be reset between tests or scoped to a session.
 *
 * PURE except for the injected `fetch` and `now`. No node built-ins — the Electron renderer
 * imports this across the C5 boundary.
 */
import type { AiEndpoint } from "./client.js";
import type { ContextWindowResult, FetchLike } from "./context-window.js";
import { probeContextWindow } from "./context-window.js";

/**
 * How long a probe result is trusted.
 *
 * EVERY entry is time-bounded, revision or no revision. An earlier draft of this comment said a
 * revision made the cache "precise" and the TTL a fallback for revision-less answers; the code
 * never did that, and it could not — a revision proves WHAT answered last time, not that the
 * same thing would answer now, and the only way to find out is the probe itself. What the
 * revision is actually good for is on the WRITE side (see `attach`): a changed digest means the
 * model was re-pulled, so capabilities measured against the old weights must not be carried
 * forward.
 *
 * Five minutes is chosen against what actually invalidates the answer: a user re-pulling a
 * model mid-session. That takes minutes of download, so a five-minute bound cannot serve a
 * stale answer for the whole of one, and it still collapses a burst of `/model` flips into a
 * single request.
 */
export const PROBE_CACHE_TTL_MS = 5 * 60_000;

/** What `attach` decided. Distinguishes "measured" from "could not measure" from "not ours to
 *  measure" — three outcomes a caller must report differently, and which a bare endpoint
 *  cannot tell apart after the fact. */
export interface EndpointProbeOutcome {
  /** The endpoint to use from here on: enriched when the probe succeeded, otherwise the input
   *  object UNCHANGED (never a half-filled copy). */
  endpoint: AiEndpoint;
  /** true ⇒ `contextWindow`/`probedCapabilities` on `endpoint` came from the runner. */
  measured: boolean;
  /** true ⇒ served from this probe's cache; no request was made. */
  fromCache: boolean;
  /**
   * true ⇒ a probe RAN and came back with nothing usable (unreachable runner, wrong runner,
   * unrecognised shape). Distinct from `measured: false` alone, which is also what a cloud
   * endpoint gets — and a cloud endpoint is not a failure, it is deliberately never probed.
   */
  failed: boolean;
}

export interface EndpointProbe {
  /**
   * Measure `endpoint` and return it enriched. Never throws and never rejects: every failure
   * path resolves to the input endpoint with `failed: true`, because a probe is an
   * optimisation and losing it must never take a session down with it.
   */
  attach(endpoint: AiEndpoint): Promise<EndpointProbeOutcome>;
  /** Drop one endpoint's cached result (or the whole cache when called with nothing). */
  invalidate(endpoint?: AiEndpoint): void;
  /** How many live requests have actually gone out. Test seam — asserts the cache works. */
  probeCount(): number;
}

interface CacheEntry {
  result: ContextWindowResult;
  atMs: number;
}

/** Cache identity. The model name is part of it: one Ollama daemon serves many models from the
 *  same baseUrl, and they have wildly different windows and capabilities. */
function cacheKey(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, "")}\x00${model}`;
}

/**
 * Is this endpoint one we may probe at all?
 *
 * LOCAL ONLY, matching `probeContextWindow`'s own rule: `/api/show` is an Ollama endpoint, and
 * firing an unknown POST at a cloud provider to satisfy curiosity is not something a
 * privacy-first client does. A cloud endpoint keeps whatever window its connector declared.
 */
function probeable(endpoint: AiEndpoint): endpoint is AiEndpoint & { model: string } {
  if (endpoint.locality !== "local") return false;
  return typeof endpoint.model === "string" && endpoint.model !== "";
}

/** Fold a successful probe into an endpoint. Capabilities fall back to what the endpoint
 *  already carried — a runner that reports a window but no `capabilities` array must not erase
 *  an earlier, richer answer. */
function enrich(
  endpoint: AiEndpoint,
  result: ContextWindowResult,
  opts: { keepPrior?: boolean } = { keepPrior: true },
): AiEndpoint {
  const capabilities =
    result.capabilities ?? (opts.keepPrior === false ? undefined : endpoint.probedCapabilities);
  // The old key is destructured OFF before the re-add. Spreading `endpoint` and then omitting
  // `probedCapabilities` does not remove it — it leaves the previous value in place, so
  // `keepPrior: false` would have been a no-op on exactly the endpoint it exists to clean.
  const { probedCapabilities: _stale, ...rest } = endpoint;
  return {
    ...rest,
    contextWindow: result.contextWindow,
    // `enrich` is only ever reached on a SUCCESSFUL probe (`attach` returns the input endpoint
    // untouched when `result.source === "default"`), so this is the one place that can honestly
    // claim the window was measured. Callers use it to decide whether the number is solid
    // enough to REFUSE a turn over — see `AiEndpoint.contextWindowMeasured`.
    contextWindowMeasured: true,
    ...(capabilities ? { probedCapabilities: capabilities } : {}),
  };
}

export interface EndpointProbeDeps {
  fetch: FetchLike;
  /** injectable clock, for the TTL. Defaults to `Date.now`. */
  now?: () => number;
  /** override `PROBE_CACHE_TTL_MS` (0 disables the cache entirely — every attach re-probes). */
  ttlMs?: number;
}

/**
 * A session-scoped probe with its own cache.
 *
 * Concurrency note: two rebinds to the SAME model in flight at once share one in-flight
 * promise rather than racing two identical POSTs — `/model a`, `/model b`, `/model a` typed
 * quickly is the normal case, not an exotic one.
 */
export function createEndpointProbe(deps: EndpointProbeDeps): EndpointProbe {
  const now = deps.now ?? ((): number => Date.now());
  const ttlMs = deps.ttlMs ?? PROBE_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<ContextWindowResult>>();
  let probes = 0;

  /** A cached entry is usable while it is inside the time bound. Purely temporal, on purpose:
   *  a revision proves WHAT answered last time, not that the same thing would answer now, so it
   *  can neither extend nor shorten freshness without a second request. */
  function fresh(entry: CacheEntry): boolean {
    return now() - entry.atMs < ttlMs;
  }

  async function run(baseUrl: string, model: string, key: string): Promise<ContextWindowResult> {
    const pending = inflight.get(key);
    if (pending) return pending;
    probes += 1;
    const p = probeContextWindow(baseUrl, model, deps.fetch)
      .catch(
        (): ContextWindowResult => ({
          // `probeContextWindow` already swallows its own errors; this is belt-and-braces for a
          // `fetch` seam that rejects before it ever gets there (a stubbed one, typically).
          contextWindow: 0,
          source: "default",
        }),
      )
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, p);
    return p;
  }

  return {
    async attach(endpoint: AiEndpoint): Promise<EndpointProbeOutcome> {
      if (!probeable(endpoint)) {
        return { endpoint, measured: false, fromCache: false, failed: false };
      }
      const key = cacheKey(endpoint.baseUrl, endpoint.model);
      const hit = cache.get(key);
      if (hit && fresh(hit)) {
        return {
          endpoint: enrich(endpoint, hit.result),
          measured: true,
          fromCache: true,
          failed: false,
        };
      }
      // The entry we are about to replace — kept for the revision comparison below. `hit` is
      // not enough: it is undefined precisely when the entry has EXPIRED, which is the case
      // that matters (a re-pull takes minutes, so the TTL has usually lapsed by then).
      const prior = cache.get(key);
      const result = await run(endpoint.baseUrl, endpoint.model, key);
      if (result.source === "default") {
        // The probe FAILED. Do NOT cache a failure: a runner that was still starting up when
        // the session opened would otherwise stay "unmeasurable" for the whole TTL, and the
        // next `/model` back to it is exactly when the user would expect it to work.
        cache.delete(key);
        return { endpoint, measured: false, fromCache: false, failed: true };
      }
      /**
       * A CHANGED digest means these are different weights: the user re-pulled the model.
       *
       * `enrich` falls back to the endpoint's existing `probedCapabilities` when a probe
       * reports none, so that a runner answering with a window and no `capabilities` array
       * cannot erase a richer earlier answer. That fallback is right for the same model and
       * wrong for a replaced one — `ollama pull` upgrading a model into (or out of) thinking
       * support would otherwise keep the OLD capability list alive for the rest of the session,
       * and those capabilities are exactly what decides whether `/think` works.
       *
       * This is the revision's one sound use. It cannot make the cache "precise" on the read
       * side, whatever the earlier comments here claimed — proving what answered last time says
       * nothing about what would answer now.
       */
      const rePulled =
        prior?.result.revision !== undefined &&
        result.revision !== undefined &&
        prior.result.revision !== result.revision;
      cache.set(key, { result, atMs: now() });
      return {
        endpoint: enrich(endpoint, result, { keepPrior: !rePulled }),
        measured: true,
        fromCache: false,
        failed: false,
      };
    },
    invalidate(endpoint?: AiEndpoint): void {
      if (!endpoint) {
        cache.clear();
        return;
      }
      if (!probeable(endpoint)) return;
      cache.delete(cacheKey(endpoint.baseUrl, endpoint.model));
    },
    probeCount(): number {
      return probes;
    },
  };
}
