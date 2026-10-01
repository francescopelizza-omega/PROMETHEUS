// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/protocol/contributors/effort-text.ts — effort tuning, as PROSE, for a model Prometheus
 * cannot address any other way.
 *
 * `ai/effort` is a request-PARAMETER mechanism: it maps a tier to `reasoning_effort`, `think`,
 * a token budget, a template kwarg, or a trained-on prompt line — but ONLY for a model+runtime
 * pair a rule in `ai/effort/rules.ts` recognises. Anything else resolves to
 * `UNKNOWN_CAPABILITY` (`mechanism:"none"`), and for those models NOTHING can go on the wire.
 *
 * This contributor is the textual fallback: when the real mechanism cannot express the tier,
 * ask for it in words instead.
 *
 * ── WHERE THE WORDS COME FROM ──────────────────────────────────────────────────────────────
 * They are NOT defined here. `ai/effort/emulation.ts` owns the table, and `resolveEffort` reads
 * the same table so that a resolution can REPORT what this contributor is about to inject
 * (`EffortResolution.emulation`, `degraded.reason: "emulated"`).
 *
 * That indirection is the whole point. This module used to hold its own private copy of the
 * prompt map, which meant `/think high` on a knobless model printed "not available" — a true
 * statement about the parameter and a false one about the outcome, because this contributor was
 * injecting a graded instruction on every single turn regardless. Two copies of one table, and
 * only one of them was visible to the layer that reports to the user.
 *
 * It deliberately does NOT fire when the mechanism ALREADY has a prompt-shaped path of its own
 * (`system-prompt-line` — gpt-oss's `Reasoning: high`; `prompt-soft-switch` — Qwen3's
 * `/think`/`/no_think`) — those are applied later, by `ai/effort/apply.ts`'s
 * `applyEffortToMessages`, and firing here too would inject the instruction TWICE, in two
 * different registers, for the one class of model that needs it least.
 */
import {
  MECHANISMS_WITH_OWN_PROMPT_PATH,
  emulationApplies,
  emulationFor,
} from "../../../ai/effort/emulation.js";
import type { PreambleContributor, PreambleCtx, PreambleUnit } from "../preamble-dispatch.js";

/** The instruction for `tier`, or null when there is nothing honest to say. Kept exported —
 *  it is the seam the contributor's own tests assert against — but it is now a thin read of
 *  the shared table rather than a second definition of it. */
export function effortText(tier: PreambleCtx["effortTier"]): string | null {
  return emulationFor(tier)?.text ?? null;
}

export const effortTextContributor: PreambleContributor = {
  id: "effort-text",
  priority: 60,
  applies: (ctx: PreambleCtx): boolean => {
    if (!ctx.effortTier || ctx.effortTier === "off") return false;
    if (ctx.effortMechanism && MECHANISMS_WITH_OWN_PROMPT_PATH.includes(ctx.effortMechanism)) {
      return false;
    }
    // Unresolved (`undefined`) is treated as "assume the worst, offer the nudge" — a caller that
    // has not resolved a capability yet should not go silent instead of trying. `template-kwarg`
    // qualifies for the same reason: `ai/effort/rules.ts` documents it as `optimistic: true` — a
    // SILENT no-op unless the model's Jinja template happens to branch on `enable_thinking` — so
    // it is exactly as unreliable as having no mechanism at all, and the textual nudge costs
    // little when the kwarg DOES work (the model just sees the same instruction twice, in two
    // registers) versus the tier being silently dropped when it doesn't.
    return emulationApplies(ctx.effortMechanism);
  },
  render: (ctx: PreambleCtx): PreambleUnit | null => {
    const text = effortText(ctx.effortTier);
    return text ? { text, mergeTarget: "persona" } : null;
  },
};
