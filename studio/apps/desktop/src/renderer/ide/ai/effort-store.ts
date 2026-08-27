/**
 * ide/ai/effort-store.ts — the composer's reasoning-effort tier (handoff §2.5 chip).
 *
 * The chip is NOT decorative. The tier here is resolved against the ACTIVE endpoint's
 * capability (`@prometheus/core/ai-effort`) and the resulting patch is applied to the
 * outgoing request by `streamChat` — a body field, a chat-template kwarg, or a literal
 * prompt line, depending on what the model was actually trained to read.
 *
 * That module's own rule is honesty: a model with no reasoning control reports `degraded`
 * and the chip says so rather than claiming a tier that was never sent.
 *
 * Renderer-SANDBOXED (C5): zustand + a PURE core subpath. No node:*, no engine-bridge.
 */

import {
  type EffortResolution,
  type EffortTier,
  isEffortTier,
  resolveCapability,
  resolveEffort,
  runtimeFromBaseUrl,
} from "@prometheus/core/ai-effort";
import { create } from "zustand";

import type { RendererEndpoint } from "./ai-client.js";

export const EFFORT_KEY = "prometheus.ai.effort.v1";

/** The ladder the chip cycles through. `off` is reachable, but not by accident. */
export const EFFORT_CYCLE: readonly EffortTier[] = ["low", "medium", "high", "max", "off"];

/** Short chip wording — "medium" is too wide for a 330px rail. */
export const EFFORT_SHORT: Record<EffortTier, string> = {
  off: "off",
  low: "low",
  medium: "med",
  high: "high",
  max: "max",
};

function load(): EffortTier {
  if (typeof window === "undefined") return "medium";
  try {
    const raw = window.localStorage.getItem(EFFORT_KEY);
    return isEffortTier(raw) ? raw : "medium";
  } catch {
    return "medium";
  }
}

function persist(tier: EffortTier): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EFFORT_KEY, tier);
  } catch {
    /* private mode / quota — the tier just won't survive this session. */
  }
}

export interface EffortStore {
  tier: EffortTier;
  setTier(tier: EffortTier): void;
  /** step to the next tier in EFFORT_CYCLE (the chip's click behaviour). */
  cycle(): void;
  /**
   * Send the effort knob even where the capability table says this model has none
   * (`ai.effortForce`). Hydrated from settings; never persisted here.
   */
  force: boolean;
  /**
   * Adopt the persisted `ai.effort` / `ai.effortForce` settings.
   *
   * The TIER is only adopted when the user has made no explicit choice on this machine — a
   * click on the chip is a decision about THIS session and must not be overwritten by a
   * config read that lands a moment later. `force` has no chip, so it always follows settings.
   */
  hydrate(tier: EffortTier | undefined, force: boolean | undefined): void;
  /** true once the user has picked a tier here — settings no longer move it. */
  chosen: boolean;
}

/**
 * Has the user explicitly chosen a tier?
 *
 * Seeded from localStorage at construction and set by `setTier` thereafter — tracked in the
 * STORE rather than re-read from localStorage on each `hydrate`, because `persist` is allowed
 * to fail (private mode, quota — it already swallows that) and a guard that depends on the
 * write having succeeded would let a settings read quietly overwrite a choice the user just
 * made with the chip.
 */
function storedChoice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return isEffortTier(window.localStorage.getItem(EFFORT_KEY));
  } catch {
    return false;
  }
}

export const useEffortStore = create<EffortStore>((set, get) => ({
  tier: load(),
  force: false,
  chosen: storedChoice(),
  setTier: (tier: EffortTier): void => {
    set({ tier, chosen: true });
    persist(tier);
  },
  cycle: (): void => {
    const i = EFFORT_CYCLE.indexOf(get().tier);
    const next = EFFORT_CYCLE[(i + 1) % EFFORT_CYCLE.length] ?? "medium";
    get().setTier(next);
  },
  hydrate: (tier: EffortTier | undefined, force: boolean | undefined): void => {
    if (force !== undefined) set({ force });
    // An explicit local choice outranks the configured default — see the interface doc.
    if (tier !== undefined && !get().chosen) set({ tier });
  },
}));

/**
 * What the requested tier ACTUALLY means for `endpoint` — the value both the chip and
 * `streamChat` consume. `undefined` when there is no endpoint to resolve against.
 */
export function effortFor(
  tier: EffortTier,
  endpoint: RendererEndpoint | null | undefined,
  opts: { force?: boolean } = {},
): EffortResolution | undefined {
  if (!endpoint) return undefined;
  const { cap } = resolveCapability({
    modelId: endpoint.model ?? endpoint.id,
    runtime: runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
    locality: endpoint.locality,
    // The load-bearing line. `resolveCapability`'s probe-driven rules score higher than every
    // name match — that is the whole design, because model ids are unstable and capability is
    // version-scoped. Omitting this (which is what Studio did) means those rules can never
    // match, EVERY local model resolves to `UNKNOWN_CAPABILITY`, and the chip reports "not
    // available" for models that advertise `thinking`. The CLI has passed it since the probe
    // existed; `endpoint-hook.ts` now fills it in here too.
    ...(endpoint.probedCapabilities ? { probedCapabilities: endpoint.probedCapabilities } : {}),
  });
  // `ai.effortForce` — off by default. When on, the knob goes out over the table's objection
  // and the resolution comes back `degraded.reason: "forced"`, so the chip warn-tints it and
  // the override is never mistaken for support this table vouched for.
  return resolveEffort(tier, cap, { ...(opts.force ? { force: true } : {}) });
}
