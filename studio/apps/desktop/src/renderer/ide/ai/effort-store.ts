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

/**
 * The ladder the chip cycles through. `off` is reachable, but not by accident.
 *
 * Every rung, including the two the ladder grew at the top (`xhigh`, `ultra`). A cycle that
 * skipped them would make the app the one surface where a paid model's strongest settings
 * cannot be asked for — and on a model that does not support them, `resolveEffort` clamps and
 * the chip says so, which is the same thing that already happens for `max` on a small model.
 */
export const EFFORT_CYCLE: readonly EffortTier[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "max",
  "off",
];

/*
 * There is deliberately NO short-label map here any more.
 *
 * `EFFORT_SHORT` used to live at this spot, justified by "medium is too wide for a 330px
 * rail". It had ZERO consumers: the composer's effort chip became a cell of the shared
 * TraitRail, whose label (`⚙ <tier>`) is built in `@prometheus/core`'s ai/effort/traits.ts
 * so the CLI and the GUI cannot disagree about it. An exported constant with a rationale
 * and no call sites is worse than nothing — it reads as a width guard that is being applied
 * somewhere, and it is not. The full tier names fit the rail as it is now; if that stops
 * being true, the fix belongs in core beside the label it would shorten, not here.
 */

function load(): EffortTier {
  if (typeof window === "undefined") return "medium";
  try {
    const raw = window.localStorage.getItem(EFFORT_KEY);
    return isEffortTier(raw) ? raw : "medium";
  } catch {
    return "medium";
  }
}

/** Update the local mirror. Never the only write — see `persist`. */
function mirror(tier: EffortTier): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EFFORT_KEY, tier);
  } catch {
    /* private mode / quota — the mirror is an optimisation, the file is the truth. */
  }
}

/**
 * Persist an EXPLICIT choice: the shared file first, the local mirror alongside it.
 *
 * localStorage used to be the only store, so a `/think max` in the terminal was invisible here
 * and clearing the app's data reset the tier with nothing on disk to recover it from — the same
 * split the autonomy level had, in a second setting.
 */
function persist(tier: EffortTier): void {
  mirror(tier);
  if (typeof window === "undefined") return;
  void window.prometheus?.effort?.set(tier)?.catch(() => undefined);
}

/**
 * Adopt the shared file's tier once the window is up.
 *
 * Called from the app shell's boot, beside `hydrateAuthLevel`. A file that has never been
 * written returns `null` — "never chosen", not "chosen to be the default" — so the seeded value
 * stands. A tier the user has already picked with the chip THIS session also stands: a decision
 * made a moment ago outranks a file read that lands after it.
 *
 * The "picked this session" guard is a MODULE-LOCAL flag, deliberately not the store's `chosen`.
 * `chosen` was seeded from localStorage, and `mirror(tier)` below writes the file's tier there —
 * so the first successful hydration made `chosen` true on the NEXT boot and this function bailed
 * at its own guard forever after. The shared file was authoritative exactly once, which is the
 * split ("a `/think max` in the terminal was invisible here") the file store exists to close.
 * The flag only has to lose to a click that happened while the async read was in flight.
 */
let pickedThisSession = false;

export async function hydrateEffortFromDisk(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const res = await window.prometheus?.effort?.get();
    const tier = res?.ok ? res.tier : null;
    if (!isEffortTier(tier)) return;
    if (pickedThisSession) return;
    // Still mirrored: `load()` uses it to seed the FIRST PAINT of the next launch, before any
    // async read can answer. It is this window's last-seen value, never a record of a choice.
    mirror(tier);
    // `chosen: true` — a tier the shared file actually holds IS an explicit choice (it was made
    // in the terminal, the CLI or a previous session), so the `ai.effort` settings default must
    // not overwrite it when AgentPane's settings hydrate lands after this read.
    useEffortStore.setState({ tier, chosen: true });
  } catch {
    /* no bridge (a browser-only render, a test) — the seeded value stands */
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

export const useEffortStore = create<EffortStore>((set, get) => ({
  tier: load(),
  force: false,
  // NOT seeded from localStorage: the mirror holds whatever tier this window last saw, including
  // one hydrated from the shared file, so reading it here reported "the user chose this" for a
  // value the user never picked — and that permanently outranked both the file and the
  // `ai.effort` setting. A choice is something made in THIS session (`setTier`) or something the
  // shared file holds (`hydrateEffortFromDisk`).
  chosen: false,
  setTier: (tier: EffortTier): void => {
    set({ tier, chosen: true });
    pickedThisSession = true; // outranks a disk read still in flight — see hydrateEffortFromDisk
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
