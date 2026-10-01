// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/effort/emulation.ts — what "think harder" can honestly mean on a model with no knob.
 *
 * Most of the ladder in `types.ts` describes REQUEST PARAMETERS: a field on the body, a
 * template kwarg, a trained-on line the model was taught to read. For `mechanism: "none"` there
 * is no such thing, and the previous behaviour was to send nothing and say "not available" —
 * which was true of the parameter and false of the outcome, because a separate module
 * (`agent/protocol/contributors/effort-text.ts`) has been quietly injecting a graded
 * instruction into the preamble for exactly these models all along.
 *
 * Two things were wrong with that split. The user was told nothing was happening while
 * something was; and the TEXT lived in the preamble layer, where `resolveEffort` — the module
 * whose entire job is to report what a tier actually does — could not see it and therefore
 * could not report it.
 *
 * This module is the shared table both now read. `resolveEffort` uses it to mark a resolution
 * `emulated` and carry the exact instruction; the preamble contributor uses it to render that
 * same instruction. One table, two readers, no drift.
 *
 * ── SCOPE, and why it is this narrow ───────────────────────────────────────────────────────
 * Prompted chain-of-thought is the one emulation technique that is both cheap and evidenced: a
 * real, modest win on math/logic for non-reasoning instruct models. It can slightly HURT
 * trivial tasks and strict-format output, which is why `off` and `low` ask for brevity rather
 * than for more thinking.
 *
 * Deliberately NOT here, and not coming:
 *   - Ungrounded self-critique. Blind self-correction flips correct answers to wrong (Huang et
 *     al., "LLMs Cannot Self-Correct Reasoning Yet"). It is token burn that makes output worse.
 *   - Temperature. Not an effort knob in either direction; low temperature is best for
 *     single-shot reasoning, so mapping effort onto it would be actively backwards.
 *   - `max_tokens` headroom. Removes a failure mode, adds no effort — never present it as one.
 * Self-consistency (k samples, majority vote) IS well-evidenced, but only where an answer is
 * checkable and it multiplies cost by k, so it belongs behind an explicit opt-in rather than in
 * a table every knobless model silently gets.
 *
 * PURE. No IO.
 */
import type { EffortEmulation, EffortTier } from "./types.js";

/** Tiers that can be emulated at all. `off` is excluded: the honest emulation of "do not
 *  deliberate" is to say nothing, not to spend tokens asking a model to think less. */
type EmulatableTier = Exclude<EffortTier, "off">;

const PROMPT_MAP: Record<EmulatableTier, string> = {
  low: "Answer efficiently: keep your reasoning brief and give a direct response.",
  medium:
    "Think through the problem for a moment before answering, but keep the deliberation short.",
  high:
    "Think carefully before you answer: consider edge cases, check your own reasoning, and " +
    "only respond once you are confident it is correct. Do not shortcut this.",
  // `xhigh` and `ultra` sit between `high` and `max`, and the prose has to sit between them too.
  // Reusing the `high` text would make three distinct rungs indistinguishable to a knobless
  // model, which is the one class of model where the prompt IS the whole mechanism.
  xhigh:
    "Work through this thoroughly before answering: explore the problem, consider the " +
    "alternatives, verify each step of your reasoning, and only then give your answer. Take " +
    "the time this needs.",
  ultra:
    "Treat this as a hard problem. Explore it from more than one angle, enumerate the " +
    "alternatives and say why you rejected the ones you rejected, check your reasoning against " +
    "the edge cases, and only give a final answer once you have verified it holds.",
  max:
    "Reason through this as thoroughly as you can before answering: enumerate the alternatives, " +
    "check your logic step by step, and only give your final answer once you have verified it. " +
    "Do not rush to a conclusion.",
};

/**
 * The instruction that stands in for a missing knob at `tier`, or null when there is nothing
 * honest to say (`off`, or an unset tier).
 */
export function emulationFor(tier: EffortTier | undefined): EffortEmulation | null {
  if (!tier || tier === "off") return null;
  return { via: "prompt-cot", text: PROMPT_MAP[tier] };
}

/**
 * Mechanisms that already have a PROMPT-shaped path of their own — gpt-oss's Harmony
 * `Reasoning: high`, Qwen3's `/think` / `/no_think`.
 *
 * These must never be emulated on top: the model was TRAINED on a specific literal, `apply.ts`
 * already emits it as a `prompt` patch, and adding a second instruction in a different register
 * would say the same thing twice to the one class of model that needs it least.
 */
export const MECHANISMS_WITH_OWN_PROMPT_PATH: readonly string[] = [
  "system-prompt-line",
  "prompt-soft-switch",
];

/**
 * Mechanisms for which a textual stand-in is appropriate.
 *
 * `none` is the obvious one. `template-kwarg` joins it because `rules.ts` marks llama.cpp/vLLM
 * `optimistic: true` — the flag is a SILENT no-op unless the model's Jinja template happens to
 * branch on `enable_thinking` — so it is exactly as unreliable as having no mechanism at all.
 * There the prose is a backup rather than a stand-in, which is why `resolveEffort` keeps
 * reporting `runtime-ignores` for it and does not relabel it `emulated`.
 *
 * `always-on` is absent on purpose: the model already reasons at a fixed depth, and telling it
 * to think harder cannot change that — it only spends tokens implying a control we do not have.
 */
export function emulationApplies(mechanism: string | undefined): boolean {
  if (mechanism === undefined) return true; // unresolved ⇒ assume the worst, offer the nudge
  return mechanism === "none" || mechanism === "template-kwarg";
}
