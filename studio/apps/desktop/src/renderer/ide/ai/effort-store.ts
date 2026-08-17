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
}

export const useEffortStore = create<EffortStore>((set, get) => ({
  tier: load(),
  setTier: (tier: EffortTier): void => {
    set({ tier });
    persist(tier);
  },
  cycle: (): void => {
    const i = EFFORT_CYCLE.indexOf(get().tier);
    const next = EFFORT_CYCLE[(i + 1) % EFFORT_CYCLE.length] ?? "medium";
    get().setTier(next);
  },
}));

/**
 * What the requested tier ACTUALLY means for `endpoint` — the value both the chip and
 * `streamChat` consume. `undefined` when there is no endpoint to resolve against.
 */
export function effortFor(
  tier: EffortTier,
  endpoint: RendererEndpoint | null | undefined,
): EffortResolution | undefined {
  if (!endpoint) return undefined;
  const { cap } = resolveCapability({
    modelId: endpoint.model ?? endpoint.id,
    runtime: runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
    locality: endpoint.locality,
  });
  return resolveEffort(tier, cap);
}
