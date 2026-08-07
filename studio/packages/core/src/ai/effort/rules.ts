/**
 * ai/effort/rules.ts — which model+runtime pair accepts which effort knob.
 *
 * Rules match on RULE, not on model id, because model ids are unstable and the same weights
 * ship under a dozen names (`qwen3:8b`, `Qwen/Qwen3-8B`, `qwen3-8b-instruct-q4`…). A runtime
 * PROBE always beats a static rule: Ollama's /api/show reports a `thinking` capability, and
 * asking the runtime is strictly better than guessing from a name. That matters more than it
 * sounds — Gemma 2/3 have no reasoning mode but Gemma 4 does, so any family-level hardcode is
 * wrong within one generation.
 *
 * Adding the 40th model should be a data edit, not a code change; `builtinRules()` is just the
 * seed, and `resolveCapability` accepts user/workspace rules layered on top.
 *
 * PURE. No IO, no fetch — the probe result is passed IN.
 */

import type { EffortCapability, EffortTier } from "./types.js";
import { EFFORT_TIERS } from "./types.js";

/** Runtimes we can tell apart, because their knobs differ. */
export type EffortRuntime =
  | "ollama"
  | "ollama-native"
  | "llamacpp"
  | "vllm"
  | "lmstudio"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openai-compatible"
  | "unknown";

export interface EffortMatch {
  runtime?: EffortRuntime;
  /** Requires the runtime probe to have reported this capability (e.g. "thinking"). */
  capability?: string;
  /** Requires the probe to have run and NOT reported `capability`. */
  capabilityAbsent?: string;
  modelIdPrefix?: string;
  modelIdRegex?: string;
  locality?: "local" | "cloud";
}

export interface EffortRule {
  id: string;
  match: EffortMatch;
  cap: EffortCapability;
}

/** Everything known about the target at resolve time. */
export interface EffortLookup {
  modelId: string;
  runtime?: EffortRuntime;
  locality?: "local" | "cloud";
  /** From a runtime probe (Ollama /api/show `capabilities`). `undefined` ⇒ never probed. */
  probedCapabilities?: readonly string[];
}

const ALL: readonly EffortTier[] = EFFORT_TIERS;

/**
 * The seed rule table.
 *
 * Every enum vocabulary below is either measured against a live server or taken from the
 * provider's published contract. Two were verified directly against Ollama 0.32.6:
 *   - native  /api/chat          `think`           → "low"|"medium"|"high"|"max"|true|false
 *   - OpenAI  /v1/chat/completions `reasoning_effort` → "low"|"medium"|"high"|"max"|"none"
 * Both error messages enumerate the accepted set, so these are not guesses. The five-tier
 * ladder maps 1:1 onto the shim vocabulary with `off → "none"`, which is why the ladder has
 * five tiers and not four or seven.
 */
export function builtinRules(): EffortRule[] {
  return [
    // ── local runtimes, probe-driven (most specific: a probe beat a guess) ─────── //
    {
      id: "ollama-openai-shim-thinking",
      match: { runtime: "ollama", capability: "thinking" },
      cap: {
        mechanism: "effort-enum",
        field: "reasoning_effort",
        supported: ALL,
        // verified: Ollama rejects "minimal" and enumerates exactly these five.
        enumMap: { off: "none", low: "low", medium: "medium", high: "high", max: "max" },
      },
    },
    {
      id: "ollama-native-thinking",
      match: { runtime: "ollama-native", capability: "thinking" },
      cap: {
        mechanism: "native-graded",
        // top-level, a SIBLING of `messages` — NOT inside `options` where sampling lives.
        field: "think",
        supported: ALL,
        enumMap: { low: "low", medium: "medium", high: "high", max: "max" },
        offValue: false,
      },
    },
    {
      // The probe ran and said no. Definitive — do not fall through to a name guess.
      id: "ollama-no-thinking",
      match: { runtime: "ollama", capabilityAbsent: "thinking" },
      cap: {
        mechanism: "none",
        supported: [],
        note: "this model has no reasoning mode (the runtime reports no `thinking` capability)",
      },
    },
    {
      id: "ollama-native-no-thinking",
      match: { runtime: "ollama-native", capabilityAbsent: "thinking" },
      cap: {
        mechanism: "none",
        supported: [],
        note: "this model has no reasoning mode (the runtime reports no `thinking` capability)",
      },
    },

    // ── always-on families: thinking cannot be turned off OR graded ────────────── //
    {
      id: "deepseek-r1",
      match: { modelIdRegex: "(^|[/:_-])(deepseek-?r1|deepseek-reasoner)" },
      cap: {
        mechanism: "always-on",
        supported: [],
        reasoningTag: "think",
        constraints: { noTemperature: true },
        // DeepSeek accepts temperature for compatibility and then ignores it — sending one
        // implies a control we do not have, so suppress it rather than pretend.
        note: "DeepSeek R1 always reasons; depth is not adjustable",
      },
    },
    {
      id: "qwq",
      match: { modelIdRegex: "(^|[/:_-])qwq" },
      cap: {
        mechanism: "always-on",
        supported: [],
        reasoningTag: "think",
        note: "QwQ always reasons; depth is not adjustable",
      },
    },
    {
      id: "kimi-k2-thinking",
      match: { modelIdRegex: "(^|[/:_-])kimi-?k2.*think" },
      cap: {
        mechanism: "always-on",
        supported: [],
        constraints: { minMaxTokens: 16000 },
        note: "Kimi K2-Thinking always reasons; depth is not adjustable",
      },
    },
    {
      id: "phi-reasoning",
      match: { modelIdRegex: "(^|[/:_-])phi-?4.*reasoning" },
      cap: {
        mechanism: "always-on",
        supported: [],
        reasoningTag: "think",
        note: "Phi-4-reasoning always reasons; depth is not adjustable",
      },
    },
    {
      id: "exaone-deep",
      match: { modelIdRegex: "(^|[/:_-])exaone.*deep" },
      cap: {
        mechanism: "always-on",
        supported: [],
        reasoningTag: "thought",
        note: "EXAONE Deep always reasons; depth is not adjustable",
      },
    },

    // ── families with NO reasoning mode at all ─────────────────────────────────── //
    {
      // Gemma 2/3/3n only. Gemma 4 DOES think, so the version bound is load-bearing.
      id: "gemma-2-3",
      match: { modelIdRegex: "(^|[/:_-])gemma-?(2|3)([^0-9]|$)" },
      cap: {
        mechanism: "none",
        supported: [],
        note: "Gemma 2/3 have no reasoning mode (Gemma 4 does)",
      },
    },
    {
      id: "llama-instruct",
      match: { modelIdRegex: "(^|[/:_-])llama-?[34]" },
      cap: { mechanism: "none", supported: [], note: "Llama 3/4 have no reasoning mode" },
    },
    {
      id: "qwen2.5",
      match: { modelIdRegex: "(^|[/:_-])qwen-?2" },
      cap: { mechanism: "none", supported: [], note: "Qwen2.x has no reasoning mode" },
    },
    {
      id: "openai-non-reasoning",
      match: { modelIdRegex: "^(gpt-4o|gpt-4\\.1|gpt-4-turbo|gpt-3)" },
      cap: {
        mechanism: "none",
        supported: [],
        // forwarding reasoning_effort here is a hard 400, not a no-op.
        note: "this GPT-4-class model has no reasoning mode",
      },
    },

    // ── hosted effort-enum providers over the OpenAI-compatible transport ──────── //
    {
      id: "openai-reasoning",
      match: { modelIdRegex: "^(o[1-9]|gpt-5|codex)" },
      cap: {
        mechanism: "effort-enum",
        field: "reasoning_effort",
        supported: ["off", "low", "medium", "high"],
        enumMap: { off: "none", low: "low", medium: "medium", high: "high" },
        note: "OpenAI exposes none/low/medium/high on this model",
      },
    },
    {
      id: "xai-grok-reasoning",
      match: { modelIdRegex: "^grok-[4-9]" },
      cap: {
        mechanism: "effort-enum",
        field: "reasoning_effort",
        // xAI reasoning models cannot be switched off.
        supported: ["low", "medium", "high"],
        enumMap: { low: "low", medium: "medium", high: "high" },
        note: "Grok reasoning cannot be disabled",
      },
    },

    // ── gpt-oss: the knob is a literal line of English in the Harmony system prompt ── //
    {
      id: "gpt-oss",
      match: { modelIdRegex: "(^|[/:_-])gpt-oss" },
      cap: {
        mechanism: "system-prompt-line",
        promptSlot: "system-append",
        supported: ["low", "medium", "high"],
        promptMap: {
          low: "Reasoning: low",
          medium: "Reasoning: medium",
          high: "Reasoning: high",
        },
        note: "gpt-oss has three levels (low/medium/high)",
      },
    },

    // ── template-kwarg runtimes: optimistic, because it is a SILENT no-op unless the
    //     model's Jinja template actually branches on enable_thinking ──────────────── //
    {
      id: "llamacpp-template-kwarg",
      match: { runtime: "llamacpp" },
      cap: {
        mechanism: "template-kwarg",
        kwarg: "enable_thinking",
        supported: ["off", "medium"],
        optimistic: true,
        note: "llama.cpp only toggles thinking for templates that branch on enable_thinking",
      },
    },
    {
      id: "vllm-template-kwarg",
      match: { runtime: "vllm" },
      cap: {
        mechanism: "template-kwarg",
        kwarg: "enable_thinking",
        supported: ["off", "medium"],
        optimistic: true,
        note: "vLLM only toggles thinking for templates that branch on enable_thinking",
      },
    },
    {
      id: "lmstudio-ignores",
      match: { runtime: "lmstudio" },
      cap: {
        mechanism: "none",
        supported: [],
        // Multiple LM Studio releases accept reasoning_effort on /v1 and do nothing with it.
        // Claiming support here would be the exact silent lie this module exists to prevent.
        note: "LM Studio ignores per-request reasoning settings; set it in the app instead",
      },
    },
  ];
}

/** Specificity: more constraints = more specific; a probe-backed match outranks a name match. */
function specificity(m: EffortMatch): number {
  let n = 0;
  if (m.runtime) n += 2;
  if (m.capability) n += 8; // a probe is authoritative
  if (m.capabilityAbsent) n += 8;
  if (m.modelIdPrefix) n += 3;
  if (m.modelIdRegex) n += 3;
  if (m.locality) n += 1;
  return n;
}

function matches(m: EffortMatch, ctx: EffortLookup): boolean {
  if (m.runtime && m.runtime !== ctx.runtime) return false;
  if (m.locality && m.locality !== ctx.locality) return false;
  if (m.capability !== undefined) {
    if (!ctx.probedCapabilities) return false; // never probed ⇒ cannot claim a probe match
    if (!ctx.probedCapabilities.includes(m.capability)) return false;
  }
  if (m.capabilityAbsent !== undefined) {
    if (!ctx.probedCapabilities) return false;
    if (ctx.probedCapabilities.includes(m.capabilityAbsent)) return false;
  }
  const id = ctx.modelId.toLowerCase();
  if (m.modelIdPrefix && !id.startsWith(m.modelIdPrefix.toLowerCase())) return false;
  if (m.modelIdRegex && !new RegExp(m.modelIdRegex, "i").test(id)) return false;
  return true;
}

/** Normalise `supported` into ladder order so `nearestTier`'s tie-break stays predictable. */
function normalise(cap: EffortCapability): EffortCapability {
  const sup = EFFORT_TIERS.filter((t) => cap.supported.includes(t));
  return { ...cap, supported: sup };
}

/** The default when nothing matches: assume no knob rather than risk a 400. */
export const UNKNOWN_CAPABILITY: EffortCapability = {
  mechanism: "none",
  supported: [],
  note: "no reasoning control is known for this model",
};

/**
 * Pick the winning capability for `ctx`. Highest specificity wins; ties go to the LATER rule,
 * so user/workspace rules appended after the builtins override them.
 */
export function resolveCapability(
  ctx: EffortLookup,
  rules: readonly EffortRule[] = builtinRules(),
): { rule: EffortRule | null; cap: EffortCapability } {
  let best: EffortRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    if (!matches(r.match, ctx)) continue;
    const s = specificity(r.match);
    if (s >= bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return best ? { rule: best, cap: normalise(best.cap) } : { rule: null, cap: UNKNOWN_CAPABILITY };
}

/** Classify an endpoint's base URL into a runtime. Ports are the reliable local signal. */
export function runtimeFromBaseUrl(baseUrl: string, locality?: "local" | "cloud"): EffortRuntime {
  const u = baseUrl.toLowerCase();
  if (u.includes("11434")) return "ollama";
  if (u.includes("1234")) return "lmstudio";
  if (u.includes("8080")) return "llamacpp";
  if (u.includes("8000")) return "vllm";
  if (u.includes("api.openai.com")) return "openai";
  if (u.includes("anthropic.com")) return "anthropic";
  if (u.includes("googleapis.com") || u.includes("generativelanguage")) return "gemini";
  return locality === "local" ? "openai-compatible" : "unknown";
}
