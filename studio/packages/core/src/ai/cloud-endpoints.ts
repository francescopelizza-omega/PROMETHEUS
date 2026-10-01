// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/cloud-endpoints.ts — turning a configured provider into an endpoint a session can use.
 *
 * An interactive Prometheus session could not reach a cloud model at all. Not "was awkward to
 * configure" — could not. The chain broke in four places at once:
 *
 *  1. The CLI's entire universe of endpoints was a two-entry hardcoded list of LOCAL runners
 *     (ollama on 11434, LM Studio on 1234). No cloud provider was ever a candidate, so
 *     `endpoint.apiKeyRef` was always undefined and the transport took its `Bearer local`
 *     branch.
 *  2. `SessionCtx.resolveKey` — the seam a cloud key would travel through — was declared,
 *     threaded through three call sites, consumed correctly, and assigned by NO host.
 *  3. The connector builders that produce a `resolveKey` (`ai/connectors/*`) have no
 *     production callers either, so nothing built a cloud endpoint for it to carry.
 *  4. Meanwhile the SWARM lane reached sixteen cloud providers happily, because it did all of
 *     this itself, inline, from one call site.
 *
 * This module is that swarm-lane knowledge, extracted so an ordinary session can use it. The
 * provider registry (`orchestration/api-providers.ts`) already holds the base URLs and the key
 * env-var names; what was missing was the two-line translation into an `AiEndpoint`.
 *
 * A PROVIDER WITH NO KEY IS NOT AN ENDPOINT. Listing one would offer the user a model that
 * cannot answer, and the failure would arrive as a 401 several seconds later rather than as
 * "you have not configured that". So discovery takes a key-presence probe and lists only what
 * can actually run.
 *
 * PURE: no fetch, no keychain, no node. The caller supplies the probe.
 */
import { API_PROVIDERS, type ApiProvider, resolveApiKey } from "../orchestration/api-providers.js";
import type { AiEndpoint } from "./client.js";
import { DEFAULT_CONTEXT_WINDOW } from "./context-window.js";

/** Where a provider's key came from — shown to the user, never the key itself. */
export type KeySource = "env" | "keychain";

export interface CloudEndpointInfo {
  endpoint: AiEndpoint;
  providerId: string;
  label: string;
  source: KeySource;
  /** the env var that supplied it, when it came from the environment. */
  envVar?: string;
}

/**
 * The `apiKeyRef` scheme.
 *
 * A ref is an OPAQUE STRING that the host's resolver understands; the raw key never lives in
 * JS state. Two forms, matching the two places a key can come from:
 *   `env:OPENROUTER_API_KEY`  — read the environment at request time
 *   `keychain:provider:groq`  — read the OS keychain at request time
 */
export function envKeyRef(envVar: string): string {
  return `env:${envVar}`;
}
export function keychainKeyRef(providerId: string): string {
  return `keychain:provider:${providerId}`;
}

/** Parse a ref back into its parts, or null when it is not one of ours. */
export function parseKeyRef(
  ref: string,
): { kind: "env"; envVar: string } | { kind: "keychain"; account: string } | null {
  if (ref.startsWith("env:")) return { kind: "env", envVar: ref.slice(4) };
  if (ref.startsWith("keychain:")) return { kind: "keychain", account: ref.slice(9) };
  return null;
}

/** Build the endpoint for one provider, given where its key lives. */
export function endpointForProvider(p: ApiProvider, ref: string, model?: string): AiEndpoint {
  const chosen = model ?? p.defaultModel;
  return {
    id: `cloud:${p.id}:${chosen}`,
    baseUrl: p.baseUrl,
    locality: "cloud",
    apiKeyRef: ref,
    /**
     * The provider's DOCUMENTED window, falling back to the floor.
     *
     * Probing a cloud endpoint to find this out is exactly the "unknown POST at a cloud
     * provider" that `probeContextWindow` refuses to do, so it comes from the registry. It
     * used to be the 8192 floor for every provider unconditionally, and that was harmless
     * only while the number merely sized the compaction budget. `preflightContext` now
     * REFUSES a request that does not fit — so on Claude (200k) and Gemini (1M) an ordinary
     * prompt with a few files in it was rejected before it was sent, by a limit twenty-five
     * times smaller than the model's real one.
     */
    contextWindow: p.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    /**
     * And the fix above was only two-thirds done: 16 of the 18 registry rows declare a window,
     * but `nexos` and `abacus` do not, so both still landed on the 8192 floor and both are
     * routed gateways onto frontier models. `preflightContext` then refused an ordinary prompt
     * at roughly 4% of the real window.
     *
     * The answer is NOT to invent numbers for them — both are `confidence: "verify"`, their
     * figures are unconfirmed by design, and a guess here would be indistinguishable from a
     * measurement later. It is to stop the floor MASQUERADING as a documented window: a row
     * with no declared window is unknown, and `preflightContext` already refuses to refuse on
     * unknown. The 8192 above stays as the budgeting hint it always was.
     *
     * This also closes the class rather than the instance — the next row added without a
     * `contextWindow` degrades to "unknown" instead of silently to 8192.
     */
    contextWindowMeasured: p.contextWindow !== undefined,
    // All three wire formats carry `tools` natively now — see `ai/wire.ts`.
    supportsTools: true,
    ...(chosen ? { model: chosen } : {}),
  };
}

/**
 * Every cloud provider that is configured on THIS machine, as a usable endpoint.
 *
 * `env` wins over the keychain, deliberately and consistently with the swarm lane: an env var
 * is an explicit, visible, per-invocation override, and a user who exports one is telling you
 * to use it. The keychain is the durable default underneath.
 */
export function discoverCloudEndpoints(opts: {
  env: Record<string, string | undefined>;
  /** whether the OS keychain holds `provider:<id>` — injected so this stays pure. */
  hasKeychainKey?: (providerId: string) => boolean;
  providers?: readonly ApiProvider[];
}): CloudEndpointInfo[] {
  const list = opts.providers ?? API_PROVIDERS;
  const out: CloudEndpointInfo[] = [];
  for (const p of list) {
    const fromEnv = resolveApiKey(p.id, opts.env);
    if (fromEnv) {
      out.push({
        endpoint: endpointForProvider(p, envKeyRef(fromEnv.env)),
        providerId: p.id,
        label: p.label,
        source: "env",
        envVar: fromEnv.env,
      });
      continue;
    }
    if (opts.hasKeychainKey?.(p.id)) {
      out.push({
        endpoint: endpointForProvider(p, keychainKeyRef(p.id)),
        providerId: p.id,
        label: p.label,
        source: "keychain",
      });
    }
  }
  return out;
}

/** A one-line, key-free description for a picker or a status line. */
export function describeCloudEndpoint(info: CloudEndpointInfo): string {
  const where = info.source === "env" ? `$${info.envVar}` : "keychain";
  return `${info.label} · ${info.endpoint.model ?? "default"} (${where})`;
}

/**
 * Which registered provider serves this base URL, if any.
 *
 * The desktop's endpoint list comes from the engine (`localai endpoints`), which hands over
 * eleven cloud base URLs and NOTHING about authentication — no provider id, no key env var. So
 * the picker offered eleven models the app could not authenticate to, and every one of them
 * failed as a 401 several seconds after the user chose it.
 *
 * Matching on the base URL is what closes that gap without inventing a new config surface: the
 * registry already knows `https://api.groq.com/openai/v1` belongs to Groq and reads
 * `GROQ_API_KEY`. Comparison is on ORIGIN + path prefix rather than string equality, because
 * the engine's list and the registry disagree about trailing slashes and the `/v1` suffix.
 */
export function providerForBaseUrl(
  baseUrl: string,
  providers: readonly ApiProvider[] = API_PROVIDERS,
): ApiProvider | undefined {
  const norm = (u: string): string => u.replace(/\/+$/, "").toLowerCase();
  const target = norm(baseUrl);
  if (!target) return undefined;
  let best: ApiProvider | undefined;
  let bestLen = -1;
  for (const p of providers) {
    const candidate = norm(p.baseUrl);
    if (!candidate) continue;
    // Longest match wins: two providers can share a host (an aggregator and its sub-path).
    if (
      (target === candidate || target.startsWith(`${candidate}/`)) &&
      candidate.length > bestLen
    ) {
      best = p;
      bestLen = candidate.length;
    }
    // The engine sometimes lists a bare origin where the registry carries the /v1 path.
    if (candidate.startsWith(`${target}/`) && target.length > bestLen) {
      best = p;
      bestLen = target.length;
    }
  }
  return best;
}
