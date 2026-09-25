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
 * Every rule carries a `provenance` marking how well-evidenced it is — see `EffortProvenance`.
 * As of the last audit that is 4 `measured`, 7 `published` and 23 `inferred`: two thirds of
 * this table is an educated guess, and the field exists so that is visible rather than
 * flattened into the same confident tone as the rows that were actually tested.
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

/**
 * How well-evidenced a rule actually is.
 *
 * This exists because a comment lied. `ollama-openai-shim-thinking` carried the line
 * "verified: Ollama rejects `minimal` and enumerates exactly these five" — presented as fact,
 * repeated in the module header as the justification for the ladder's shape, and false on both
 * counts when finally re-measured. It survived review precisely because it read as though
 * someone had checked.
 *
 * A comment can drift from the truth silently. A required FIELD cannot: a rule with no
 * provenance fails a test, and a reader can see at a glance which rows are measured and which
 * are educated guesses. That distinction is load-bearing here — sending a wrong parameter is a
 * hard 400 on some providers and a silent no-op on others, which is the whole reason this
 * module exists.
 *
 *   "measured"  — sent at a live server and the accepted set read back out of its error.
 *   "published" — taken from the provider's current documented contract.
 *   "inferred"  — assembled from release notes, model cards and prior knowledge, and NOT
 *                 verified end to end. Treat as the weakest evidence in the file.
 */
export type EffortProvenance = "measured" | "published" | "inferred";

export interface EffortRule {
  id: string;
  match: EffortMatch;
  cap: EffortCapability;
  /** How this row's vocabulary was established — see `EffortProvenance`. Required on every
   *  builtin (enforced by a test); optional on a user/workspace override. */
  provenance?: EffortProvenance;
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
 * The five-rung ladder as it stood before `xhigh`/`ultra` were added.
 *
 * `ALL` means "every rung this ladder has", and it is the RIGHT answer only for a backend that
 * genuinely accepts every one of them. When the ladder grew, three rules were spelled `ALL` —
 * and two of them were measured against servers whose vocabulary does NOT include the new
 * rungs, so leaving them as `ALL` would have turned a measured fact into a false claim and
 * posted `think: "xhigh"` at a daemon that answers 400. Those two now name this set explicitly.
 */
const CLASSIC_FIVE: readonly EffortTier[] = ["off", "low", "medium", "high", "max"];

/**
 * The seed rule table.
 *
 * Every enum vocabulary below is either measured against a live server or taken from the
 * provider's published contract. Two were verified directly against a live Ollama daemon, by
 * sending a deliberately invalid value and reading the accepted set back out of the 400:
 *   - native /api/chat            `think`            → "high"|"medium"|"low"|"max"|true|false
 *   - OpenAI /v1/chat/completions `reasoning_effort` → "minimal"|"low"|"medium"|"high"
 *                                                      |"xhigh"|"ultra"|"max"|"none"
 *
 * The shim's set is WIDER than this ladder, and that is a deliberate subset rather than a
 * coincidence: `minimal`, `xhigh` and `ultra` have no tier here. The five tiers exist because
 * five is what a person can hold in their head and what every OTHER backend can be mapped onto
 * — not because any one provider happens to expose five. (An earlier version of this comment
 * claimed the shim "rejects `minimal`" and "enumerates exactly these five", and that the ladder
 * was a 1:1 map onto it. Re-measured against the daemon: `minimal` is ACCEPTED, the set has
 * eight members, and the 1:1 story was wrong. The MAPPING below was, and remains, correct —
 * every value it emits is in the accepted set — but the justification was not.)
 */
export function builtinRules(): EffortRule[] {
  return [
    // ── local runtimes, probe-driven (most specific: a probe beat a guess) ─────── //
    {
      id: "ollama-openai-shim-thinking",
      provenance: "measured",
      match: { runtime: "ollama", capability: "thinking" },
      cap: {
        mechanism: "effort-enum",
        field: "reasoning_effort",
        supported: ALL,
        // Re-measured live: the daemon accepts minimal|low|medium|high|xhigh|ultra|max|none.
        // Every value emitted here is in that set. `minimal` is still not emitted — it is a
        // deliberate ladder choice (see the module header), not a limit of the server — but
        // `xhigh` and `ultra` now have rungs and are passed straight through: this is the one
        // backend measured accepting `ultra`, which is why the rung exists at all.
        enumMap: {
          off: "none",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          ultra: "ultra",
          max: "max",
        },
      },
    },
    {
      id: "ollama-native-thinking",
      provenance: "measured",
      match: { runtime: "ollama-native", capability: "thinking" },
      cap: {
        mechanism: "native-graded",
        // top-level, a SIBLING of `messages` — NOT inside `options` where sampling lives.
        field: "think",
        // MEASURED against the daemon: `think` accepts "high"|"medium"|"low"|"max"|true|false.
        // `xhigh`/`ultra` are NOT in that set — they exist only on the OpenAI-compatible `/v1`
        // shim above — so this rule names the five explicitly instead of tracking the ladder.
        supported: CLASSIC_FIVE,
        enumMap: { low: "low", medium: "medium", high: "high", max: "max" },
        offValue: false,
      },
    },
    {
      // The probe ran and said no. Definitive — do not fall through to a name guess.
      id: "ollama-no-thinking",
      provenance: "measured",
      match: { runtime: "ollama", capabilityAbsent: "thinking" },
      cap: {
        mechanism: "none",
        supported: [],
        note: "this model has no reasoning mode (the runtime reports no `thinking` capability)",
      },
    },
    {
      id: "ollama-native-no-thinking",
      provenance: "measured",
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
      provenance: "inferred",
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
      provenance: "inferred",
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
      provenance: "inferred",
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
      provenance: "inferred",
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
      provenance: "inferred",
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
      provenance: "inferred",
      match: { modelIdRegex: "(^|[/:_-])gemma-?(2|3)([^0-9]|$)" },
      cap: {
        mechanism: "none",
        supported: [],
        note: "Gemma 2/3 have no reasoning mode (Gemma 4 does)",
      },
    },
    {
      id: "llama-instruct",
      provenance: "inferred",
      match: { modelIdRegex: "(^|[/:_-])llama-?[34]" },
      cap: { mechanism: "none", supported: [], note: "Llama 3/4 have no reasoning mode" },
    },
    {
      id: "qwen2.5",
      provenance: "inferred",
      match: { modelIdRegex: "(^|[/:_-])qwen-?2" },
      cap: { mechanism: "none", supported: [], note: "Qwen2.x has no reasoning mode" },
    },
    {
      id: "openai-non-reasoning",
      provenance: "published",
      match: { modelIdRegex: "^(gpt-4o|gpt-4\\.1|gpt-4-turbo|gpt-3)" },
      cap: {
        mechanism: "none",
        supported: [],
        // forwarding reasoning_effort here is a hard 400, not a no-op.
        note: "this GPT-4-class model has no reasoning mode",
      },
    },

    // ── Anthropic ──────────────────────────────────────────────────────────────
    //
    // EVERY rule below is pinned to `runtime: "anthropic"`, and that is load-bearing rather
    // than tidy. The effort dialect is a property of the ENDPOINT, not of the model name: a
    // proxy that serves `claude-opus-4-8` over an OpenAI-compatible API (OpenRouter and the
    // 16 of the 18 providers in `orchestration/api-providers.ts` are) takes a completely
    // different field, so matching on the name alone would post `output_config.effort` at a
    // server that has never heard of it. Unmatched there means the tier is emulated instead —
    // the SAFE failure, and the one this module is built around.
    //
    // The vocabulary here changed twice, and both changes are HARD ERRORS rather than no-ops,
    // which is why the version bounds below are load-bearing rather than tidy:
    //
    //   - `thinking.budget_tokens` — the shape everyone remembers — is DEPRECATED on Opus 4.6 /
    //     Sonnet 4.6 and returns a 400 on Fable 5, Opus 5, Opus 4.8, Opus 4.7 and Sonnet 5.
    //   - `output_config.effort` (GA, no beta header) replaced it: low|medium|high|xhigh|max.
    //   - `temperature` is REMOVED on the same generation that dropped `budget_tokens` — sending
    //     one is a 400, not a silently ignored field. That is what `noTemperature` is for.
    //
    // `xhigh` DOES have a ladder rung now (see `EFFORT_TIERS`), and it is mapped on exactly the
    // model set the vendor documents it for. The objection this comment used to record — that a
    // sixth tier "would push the vocabulary of the strongest backend onto every other one" — was
    // answered by `supported` + `nearestTier` rather than by keeping the rung out: a backend
    // declares what it accepts, anything else clamps, and the clamp is reported. What made the
    // objection true in practice was three rules spelled `supported: ALL`; they now name their
    // measured sets (`CLASSIC_FIVE`).
    {
      id: "anthropic-effort-current",
      provenance: "published",
      // Fable 5 / Mythos 5 / Opus 5 / Opus 4.8 / Opus 4.7 / Sonnet 5.
      match: {
        runtime: "anthropic",
        modelIdRegex: "^claude-(fable-5|mythos-5|opus-5|opus-4-[78]|sonnet-5)",
      },
      cap: {
        mechanism: "effort-enum",
        field: "output_config.effort",
        // No `off`: thinking cannot be switched off through this field. `thinking:{type:
        // "disabled"}` is a DIFFERENT parameter, it is a 400 on Fable 5 outright, and on Opus 5
        // it is only accepted at effort `high` or below — a conditional second field is not
        // something a single patch can express honestly, so `off` clamps to `low` and says so.
        //
        // `xhigh` is documented on EXACTLY this model set (Fable 5, Mythos 5, Opus 5, Opus 4.8,
        // Opus 4.7, Sonnet 5) and is the vendor's recommended starting point for coding and
        // agentic work on the Opus 4.7/4.8 generation. It is deliberately absent from the 4.6
        // rule below, where the vendor lists `max` but not `xhigh`.
        //
        // `ultra` is NOT an Anthropic value and is not listed here: asking for it clamps to
        // `xhigh` — the nearest rung this provider has — and `resolveEffort` reports the clamp.
        supported: ["low", "medium", "high", "xhigh", "max"],
        enumMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
        // A 400, not a no-op: this generation removed the sampling parameters entirely.
        constraints: { noTemperature: true },
        note: "Claude 4.7+ reasoning cannot be disabled (and rejects temperature)",
      },
    },
    {
      id: "anthropic-effort-4-6",
      provenance: "published",
      match: { runtime: "anthropic", modelIdRegex: "^claude-(opus|sonnet)-4-6" },
      cap: {
        mechanism: "effort-enum",
        field: "output_config.effort",
        // `max` yes, `xhigh` NO. The vendor's own table lists 4.6 under `max` and omits it from
        // `xhigh` ("some models that support `max` don't support `xhigh`"), so a ladder request
        // for xhigh clamps here rather than posting a value this generation does not take.
        supported: ["low", "medium", "high", "max"],
        enumMap: { low: "low", medium: "medium", high: "high", max: "max" },
        // Temperature is still allowed on this generation — do NOT suppress it here.
        note: "Claude 4.6 has low/medium/high/max (no xhigh) and cannot disable reasoning",
      },
    },
    {
      id: "anthropic-effort-opus-4-5",
      provenance: "published",
      match: { runtime: "anthropic", modelIdRegex: "^claude-opus-4-5" },
      cap: {
        mechanism: "effort-enum",
        field: "output_config.effort",
        // Three levels only — `xhigh`/`max` arrived later, and `max` here would be a 400.
        supported: ["low", "medium", "high"],
        enumMap: { low: "low", medium: "medium", high: "high" },
        note: "Opus 4.5 exposes low/medium/high only",
      },
    },
    {
      id: "anthropic-budget-4-5",
      provenance: "published",
      // Sonnet 4.5 / Haiku 4.5: `output_config.effort` ERRORS here; thinking is a token budget.
      match: { runtime: "anthropic", modelIdRegex: "^claude-(sonnet|haiku)-4-5" },
      cap: {
        mechanism: "token-budget",
        field: "thinking.budget_tokens",
        supported: ["low", "medium", "high", "max"],
        budgetMap: { low: 1024, medium: 4096, high: 16384, max: 32000 },
        // 1024 is the provider MINIMUM, not a chosen floor — below it the request errors.
        budgetBounds: { min: 1024, max: 32000 },
        // The headroom is what keeps the tiers DISTINCT: without it every tier above low
        // collapsed onto `max_tokens - 1` and the answer got a single token.
        //
        // It is ALSO the answer's entire budget: `max_tokens = thinking + headroom`, so a
        // headroom of 4096 meant that at `max` effort the model could think for 32,000 tokens
        // and then had 4,096 left to actually answer in — on a model that serves 64,000. The
        // headroom now matches the thinking ceiling, so 32k of reasoning still leaves 32k of
        // answer and the total stays inside the model's documented 64,000 output limit.
        constraints: { budgetUnderMaxTokens: true, budgetAnswerHeadroom: 32_000 },
        note: "Claude 4.5 takes a thinking token budget, not an effort level",
      },
    },
    {
      id: "anthropic-claude-3",
      provenance: "published",
      match: { runtime: "anthropic", modelIdRegex: "^claude-3" },
      cap: { mechanism: "none", supported: [], note: "Claude 3.x has no reasoning mode" },
    },

    // ── Gemini ─────────────────────────────────────────────────────────────────
    //
    // Pinned to `runtime: "gemini"` for the same reason as the Anthropic block above: these
    // fields are Google's own wire shape, and an aggregator serving `gemini-2.5-pro` over an
    // OpenAI-compatible API would not understand them.
    //
    // Both fields nest under `generationConfig`, which `ai/wire.ts` already builds — `setPath`
    // merges into it rather than replacing it, so a temperature/maxOutputTokens already there
    // survives.
    {
      id: "gemini-3-thinking-level",
      provenance: "inferred",
      match: { runtime: "gemini", modelIdRegex: "^gemini-3" },
      cap: {
        mechanism: "effort-enum",
        field: "generationConfig.thinkingConfig.thinkingLevel",
        supported: ["low", "medium", "high"],
        enumMap: { low: "low", medium: "medium", high: "high" },
        note: "Gemini 3 exposes low/medium/high thinking levels",
      },
    },
    {
      id: "gemini-2-5-budget",
      provenance: "inferred",
      // Flash / Flash-Lite: a 0 budget genuinely turns thinking off.
      match: { runtime: "gemini", modelIdRegex: "^gemini-2\\.5" },
      cap: {
        mechanism: "token-budget",
        field: "generationConfig.thinkingConfig.thinkingBudget",
        // The five the budget map has numbers for. Tracking the ladder here would have claimed
        // support for `xhigh`/`ultra` while `budgetMap` had no entry for either — a supported
        // tier with no budget resolves to an undefined field value, not to a sensible default.
        supported: CLASSIC_FIVE,
        budgetMap: { low: 1024, medium: 4096, high: 16384, max: 24576 },
        budgetBounds: { min: 0, max: 24576, disableWith: 0 },
        note: "Gemini 2.5 Flash takes a thinking token budget",
      },
    },

    {
      id: "gemini-2-5-pro-budget",
      provenance: "inferred",
      // Pro CANNOT disable thinking — a 0 budget is rejected, so `off` must not be offered.
      //
      // Declared AFTER the general 2.5 rule on purpose: both match on `modelIdRegex` alone, so
      // both score the same specificity, and `resolveCapability` breaks that tie in favour of
      // the LATER rule. Ordering IS the disambiguation here — moving this block up would
      // silently hand Pro the Flash capability, complete with an `off` tier that 400s.
      match: { runtime: "gemini", modelIdRegex: "^gemini-2\\.5-pro" },
      cap: {
        mechanism: "token-budget",
        field: "generationConfig.thinkingConfig.thinkingBudget",
        supported: ["low", "medium", "high", "max"],
        budgetMap: { low: 1024, medium: 4096, high: 16384, max: 32768 },
        budgetBounds: { min: 128, max: 32768 },
        note: "Gemini 2.5 Pro always reasons; only the budget is adjustable",
      },
    },
    // ── open-weight families whose knob is a trained-on STRING, not a parameter ──
    {
      // Qwen3's switch is a token the model was trained on, appended to the user turn. It is
      // the mechanism `types.ts` names as the `prompt-soft-switch` exemplar and the table has
      // never had a rule for — which is why every `qwen3*` id newer than the `qwen-?2` regex
      // fell through to UNKNOWN_CAPABILITY unless a runtime probe rescued it.
      //
      // Deliberately LOWER specificity than the Ollama probe rules (a name match scores 3, a
      // probe match 8+), so a probed Ollama endpoint still wins and this is the fallback for
      // llama.cpp/vLLM/unclassified runtimes that serve the same weights.
      id: "qwen3-soft-switch",
      provenance: "inferred",
      // VERSION-BOUNDED, exactly like the gemma rule above and for the same reason: the
      // `/think` token is a Qwen3.0 training artefact, and a point release that dropped it
      // would receive a stray literal in its user turn. `qwen3:8b` and `qwen3-8b` match;
      // `qwen3.6` deliberately does NOT and falls through to "unknown", which is the honest
      // answer for weights whose switch we have not verified.
      //
      // VARIANT-BOUNDED too, and this one was measured rather than reasoned: the shipped
      // registry in `orchestration/api-providers.ts` carries `qwen-3-coder-480b` and
      // `qwen-3-235b-a22b-instruct`, and BOTH were matching. The `-instruct` and `-coder`
      // lines are the explicitly NON-thinking halves of the Qwen3 split — appending `/think`
      // to them puts a stray literal in the user's own message on every single turn, for a
      // switch those weights do not implement. A hybrid `qwen3:8b` still matches.
      match: {
        modelIdRegex: "(^|[/:_-])qwen-?3(?![.0-9])(?!.*(instruct|coder))",
      },
      cap: {
        mechanism: "prompt-soft-switch",
        promptSlot: "user-append",
        // Binary in the model's training: there is a think token and a no-think token, and
        // nothing in between. `medium` is the honest middle of a two-value switch — `low`/`high`
        // clamp to it rather than implying a gradation the weights do not have.
        supported: ["off", "medium"],
        promptMap: { off: "/no_think", medium: "/think" },
        reasoningTag: "think",
        note: "Qwen3 takes a /think or /no_think switch, not a graded level",
      },
    },
    {
      id: "nemotron",
      provenance: "inferred",
      match: { modelIdRegex: "(^|[/:_-])nemotron" },
      cap: {
        mechanism: "system-prompt-line",
        promptSlot: "system-append",
        supported: ["off", "medium"],
        promptMap: { off: "detailed thinking off", medium: "detailed thinking on" },
        note: "Nemotron takes a literal `detailed thinking on|off` system line",
      },
    },
    {
      id: "glm-thinking-toggle",
      provenance: "inferred",
      match: { modelIdRegex: "(^|[/:_-])glm-?[45]" },
      cap: {
        mechanism: "binary-toggle",
        field: "thinking.type",
        supported: ["off", "medium"],
        onValue: "enabled",
        offValue: "disabled",
        note: "GLM thinking is on/off only, with no depth control",
      },
    },
    {
      id: "deepseek-v3-2-toggle",
      provenance: "inferred",
      // V3.2 is a TOGGLE, unlike R1 above which is always-on — the two must not be collapsed.
      match: { modelIdRegex: "(^|[/:_-])deepseek-?v3\\.?2" },
      cap: {
        mechanism: "binary-toggle",
        field: "thinking.type",
        supported: ["off", "medium"],
        onValue: "enabled",
        offValue: "disabled",
        constraints: { noTemperature: true },
        note: "DeepSeek V3.2 thinking is on/off only",
      },
    },
    {
      id: "granite-thinking-toggle",
      provenance: "inferred",
      match: { modelIdRegex: "(^|[/:_-])granite-?[34]" },
      cap: {
        mechanism: "binary-toggle",
        field: "thinking",
        supported: ["off", "medium"],
        note: "Granite thinking is on/off only",
      },
    },

    // ── hosted effort-enum providers over the OpenAI-compatible transport ──────── //
    {
      id: "openai-reasoning",
      provenance: "published",
      // The o-series. Kept at the conservative four: `reasoning.effort` is documented as
      // model-dependent, the newer rungs arrived with the gpt-5 line, and an unsupported enum
      // value here is a 400 rather than a no-op.
      match: { modelIdRegex: "^o[1-9]" },
      cap: {
        mechanism: "effort-enum",
        field: "reasoning_effort",
        supported: ["off", "low", "medium", "high"],
        enumMap: { off: "none", low: "low", medium: "medium", high: "high" },
        note: "OpenAI exposes none/low/medium/high on this model",
      },
    },
    {
      id: "openai-reasoning-gpt5",
      provenance: "published",
      // gpt-5.x and codex. The published vocabulary is
      // `none | minimal | low | medium | high | xhigh | max`, so this line reaches two rungs the
      // o-series does not.
      //
      // `minimal` has no rung on this ladder ON PURPOSE — it is a shade of `low`, not a distinct
      // depth, and the header explains why the BOTTOM of the ladder stays coarse. `ultra` is not
      // an OpenAI value at all (it was measured on the local Ollama shim), so it clamps to
      // `xhigh` and the clamp is reported.
      match: { modelIdRegex: "^(gpt-5|codex)" },
      cap: {
        mechanism: "effort-enum",
        field: "reasoning_effort",
        supported: ["off", "low", "medium", "high", "xhigh", "max"],
        enumMap: {
          off: "none",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        note: "OpenAI gpt-5/codex expose none/low/medium/high/xhigh/max",
      },
    },
    {
      id: "xai-grok-reasoning",
      provenance: "inferred",
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
      provenance: "inferred",
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
      provenance: "inferred",
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
      provenance: "inferred",
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
      /**
       * llama.cpp / vLLM serving Qwen3 — the RUNTIME knob wins over the model's own token.
       *
       * Both of these forward `chat_template_kwargs` into the Jinja template, and Qwen3's
       * template is the canonical one that branches on `enable_thinking` — so here the
       * "optimistic" mechanism is not a guess at all, and it is strictly better than appending
       * a literal to the user's message.
       *
       * Runtime + name scores 5 against the bare `qwen3-soft-switch` name match's 3, which is
       * what makes this win. Without these two rules the name rule would outrank the runtime
       * one and every llama.cpp/vLLM Qwen3 would silently lose its template kwarg.
       */
      id: "llamacpp-qwen3-template",
      provenance: "inferred",
      match: { runtime: "llamacpp", modelIdRegex: "(^|[/:_-])qwen-?3([^.0-9]|$)" },
      cap: {
        mechanism: "template-kwarg",
        kwarg: "enable_thinking",
        supported: ["off", "medium"],
        optimistic: true,
        reasoningTag: "think",
        note: "llama.cpp only toggles thinking for templates that branch on enable_thinking",
      },
    },
    {
      id: "vllm-qwen3-template",
      provenance: "inferred",
      match: { runtime: "vllm", modelIdRegex: "(^|[/:_-])qwen-?3([^.0-9]|$)" },
      cap: {
        mechanism: "template-kwarg",
        kwarg: "enable_thinking",
        supported: ["off", "medium"],
        optimistic: true,
        reasoningTag: "think",
        note: "vLLM only toggles thinking for templates that branch on enable_thinking",
      },
    },
    {
      id: "lmstudio-ignores",
      provenance: "inferred",
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

/**
 * Classify an endpoint's base URL into a runtime. Ports are the reliable local signal.
 *
 * NOTE — `"ollama-native"` is deliberately NEVER returned here. Port 11434 answers BOTH the
 * OpenAI-compatible `/v1` shim and the native `/api/chat`, and they take different knobs
 * (`reasoning_effort` vs a top-level `think`), so the URL alone cannot tell them apart. Every
 * chat request this repo makes goes through the `/v1` shim (`ai/wire.ts` has no native-Ollama
 * format), so guessing `ollama-native` from a bare `:11434` would put a `think` field on an
 * OpenAI-shaped body — the exact silent-mismatch class this module exists to prevent.
 *
 * The `ollama-native-*` rules are therefore reachable only by an explicit
 * `resolveCapability({ runtime: "ollama-native", … })` — which is what a caller with a real
 * native transport, or a workspace rule override, would pass. They are pinned by tests rather
 * than left as decoration.
 */
/** Local runners, identified by the port they actually listen on. */
const RUNNER_PORTS: ReadonlyMap<string, EffortRuntime> = new Map([
  ["11434", "ollama"],
  ["1234", "lmstudio"],
  ["8080", "llamacpp"],
  ["8000", "vllm"],
]);

/** Cloud providers, identified by hostname suffix. */
const PROVIDER_HOSTS: ReadonlyArray<readonly [string, EffortRuntime]> = [
  ["api.openai.com", "openai"],
  ["anthropic.com", "anthropic"],
  ["googleapis.com", "gemini"],
  ["generativelanguage.googleapis.com", "gemini"],
];

/**
 * Which runtime a base URL denotes — the answer that picks the WIRE PROTOCOL
 * (`ai/wire.ts`'s `selectWire`), so getting it wrong means every frame parses to nothing and the
 * model appears to answer with silence.
 *
 * This used to be a list of `String.includes` tests over the whole lowercased URL, with the PORT
 * numbers checked FIRST. A substring matches anywhere — path, query string, even the model name
 * — so:
 *   `https://api.anthropic.com:443/v1?x=8000`  → "vllm"      (a real Anthropic endpoint)
 *   `https://api.mycorp.com/v1/model-8080`     → "llamacpp"
 *   `http://host/v1234/`                       → "lmstudio"
 * The host is now matched against the parsed HOSTNAME and the port against the parsed PORT, and
 * a known provider host wins over any port, because a hostname is the stronger signal.
 *
 * A URL that does not parse falls back to the old substring behaviour rather than throwing —
 * this function must never be the thing that breaks a turn.
 */
export function runtimeFromBaseUrl(baseUrl: string, locality?: "local" | "cloud"): EffortRuntime {
  let host = "";
  let port = "";
  try {
    const parsed = new URL(baseUrl);
    host = parsed.hostname.toLowerCase();
    port = parsed.port;
    // `new URL("localhost:11434")` does NOT throw — it parses as scheme `localhost:` with an
    // empty hostname. A schemeless `host:port` is a real thing users type into a base-URL box,
    // so an empty hostname means "this was not an absolute URL", same as a throw.
    if (!host) throw new Error("no hostname");
    // an omitted port means the scheme default, which is never a local runner's port
    if (!port)
      port = parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "";
  } catch {
    // not an absolute URL (a bare `host:port`, a template, a config typo) — degrade to the old
    // scan rather than mis-answering, and keep the host check ahead of the port check.
    const u = baseUrl.toLowerCase();
    for (const [h, rt] of PROVIDER_HOSTS) if (u.includes(h)) return rt;
    if (u.includes("generativelanguage")) return "gemini";
    for (const [p, rt] of RUNNER_PORTS) if (u.includes(`:${p}`)) return rt;
    return locality === "local" ? "openai-compatible" : "unknown";
  }
  // A known provider HOST is decisive — it cannot be confused with a local runner.
  for (const [h, rt] of PROVIDER_HOSTS) {
    if (host === h || host.endsWith(`.${h}`)) return rt;
  }
  const byPort = RUNNER_PORTS.get(port);
  if (byPort) return byPort;
  return locality === "local" ? "openai-compatible" : "unknown";
}
