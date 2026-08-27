/**
 * ai/effort/types.ts — the vocabulary for cross-model reasoning-effort control.
 *
 * One user-facing ladder (`off < low < medium < high < max`) drives N wildly different
 * backend dialects. The models genuinely do not share a concept: Anthropic takes a string
 * enum, Gemini 2.5 an integer budget, Ollama a top-level `think` field, gpt-oss a literal
 * line of English in a Harmony system prompt, Qwen3 a Jinja template kwarg — and DeepSeek
 * R1, Kimi K2-Thinking and Gemma 3 take nothing at all, for three DIFFERENT reasons.
 *
 * The load-bearing rule here is HONESTY: resolving an effort never returns a bare tier. It
 * returns what was asked, what was actually applied, and — whenever those differ — why.
 * A caller that forwards a knob blindly gets a 400 on GPT-4o and a silent no-op on
 * LM Studio; a UI that shows `effort: high` on a model with no reasoning mode is lying.
 *
 * PURE types + PURE helpers. No IO.
 */

/** The user-facing ladder. `off` means "answer directly, no deliberation". */
export type EffortTier = "off" | "low" | "medium" | "high" | "max";

/** Ascending. Index order is the clamp order — see `nearestTier`. */
export const EFFORT_TIERS: readonly EffortTier[] = ["off", "low", "medium", "high", "max"];

export function isEffortTier(v: unknown): v is EffortTier {
  return typeof v === "string" && (EFFORT_TIERS as readonly string[]).includes(v);
}

/**
 * The structurally distinct kinds of knob that exist in the wild. Every model+runtime pair
 * falls into exactly one. Three of these are NOT request parameters, which is the whole
 * reason a single `reasoning_effort` passthrough cannot work.
 */
export type EffortMechanism =
  /** string enum in the body — OpenAI `reasoning_effort`, Anthropic `output_config.effort`,
   *  Gemini 3 `thinkingLevel`, xAI, and Ollama's OpenAI-compatible `/v1` shim. */
  | "effort-enum"
  /** integer token budget — Anthropic legacy `thinking.budget_tokens`, Gemini 2.5
   *  `thinkingBudget`, Cohere `thinking.token_budget`. */
  | "token-budget"
  /** a graded field in a non-OpenAI shape — Ollama native `/api/chat` `think`. */
  | "native-graded"
  /** on/off only — GLM `thinking.type`, DeepSeek V3.2, Granite, Ollama `think: true|false`. */
  | "binary-toggle"
  /** a Jinja chat-template kwarg forwarded by the runtime (llama.cpp / vLLM
   *  `chat_template_kwargs.enable_thinking`). Silently a no-op unless the model's template
   *  actually branches on it — see `optimistic`. */
  | "template-kwarg"
  /** a trained-on literal string in the system message — gpt-oss Harmony `Reasoning: high`,
   *  Nemotron `detailed thinking on`, Magistral. */
  | "system-prompt-line"
  /** a trained-on token appended to a turn — Qwen3 `/think` `/no_think`, SmolLM3. */
  | "prompt-soft-switch"
  /** thinking is permanently on AND its depth is not adjustable — DeepSeek R1, QwQ,
   *  Kimi K2-Thinking, Phi-4-reasoning, EXAONE Deep.
   *
   *  BOTH halves are required. A model that always reasons but exposes a depth control is NOT
   *  this: Gemini 2.5 Pro takes a `thinkingBudget` and Claude Fable 5 takes
   *  `output_config.effort`, so both are graded mechanisms whose `supported` set simply omits
   *  `off`. Filing them here would report "not available" for a dial that works. */
  | "always-on"
  /** no reasoning capability at all — Gemma 2/3/3n, Llama 3.x/4, Phi-4, GPT-4o. */
  | "none";

/** Side-constraints that BREAK a request if violated. Enforced by `resolveEffort`. */
export interface EffortConstraints {
  /** DeepSeek thinking mode silently ignores temperature; Moonshot k2.6+ rejects it. */
  noTemperature?: boolean;
  /** Moonshot pins this value and makes it unmodifiable. */
  pinTemperature?: number;
  /** Anthropic: budget_tokens must be strictly < max_tokens, else HTTP 400. */
  budgetUnderMaxTokens?: boolean;
  /**
   * The provider's MINIMUM thinking budget, mirrored from `budgetBounds.min` when the
   * resolution is built.
   *
   * `buildPatch` already clamps to `budgetBounds`, but `applyEffort` re-clamps against the
   * `max_tokens` actually on the body — the only place that number is known — and it sees the
   * resolution, not the capability. Without the floor here that second clamp could push the
   * budget BELOW the provider minimum and produce the exact 400 it exists to prevent.
   */
  budgetMin?: number;
  /** Kimi K2-Thinking: reasoning + answer must fit, so max_tokens needs a floor. */
  minMaxTokens?: number;
  /**
   * Tokens that must remain for the ANSWER once the thinking budget is subtracted.
   *
   * `budgetUnderMaxTokens` alone only requires `budget < max_tokens`, and the clamp that
   * enforced it used `max_tokens - 1`. On Claude 4.5 with the wire's default `max_tokens: 4096`
   * that turned medium (4096), high (16384) and max (32000) into the SAME request —
   * `budget_tokens: 4095` — leaving exactly one token for the reply. Declared per-rule, so a
   * capability that has no such requirement is unaffected (the clamp stays `- 1`).
   */
  budgetAnswerHeadroom?: number;
  /**
   * Did the CALLER pin `max_tokens`, or is the number on the body a library default?
   *
   * Set by `resolveEffort` from `ctx.maxTokens`, because that is the only place that can tell
   * the two apart — by the time `applyEffort` sees the body, `ai/wire.ts` has already
   * substituted `ANTHROPIC_DEFAULT_MAX_TOKENS` for an omitted value and the two are
   * indistinguishable. A caller's ceiling is a hard cost limit and the budget yields to it; OUR
   * default is not, and must not silently cap the tier the user asked for.
   */
  ceilingFromCaller?: boolean;
}

/** How ONE model+runtime pair accepts — or refuses — an effort setting. */
export interface EffortCapability {
  mechanism: EffortMechanism;
  /** The tiers this pair can actually express. Empty ⇒ no knob at all. */
  supported: readonly EffortTier[];
  /** Dotted path from the body root: "reasoning_effort", "think", "thinking.type". */
  field?: string;
  /** `effort-enum` / `native-graded`: our tier → this backend's vocabulary. */
  enumMap?: Partial<Record<EffortTier, string>>;
  /** Value to send for `off` when it is not a plain enum member (e.g. Ollama `think:false`). */
  offValue?: unknown;
  /** `token-budget`: tier → tokens. */
  budgetMap?: Partial<Record<EffortTier, number>>;
  /** Hard bounds the provider enforces; `disableWith` is the value that means "no thinking". */
  budgetBounds?: { min: number; max: number; disableWith?: number };
  /** `binary-toggle`: the value pair. Defaults to true/false. */
  onValue?: unknown;
  /** `template-kwarg`: the kwarg name, nested under `chat_template_kwargs`. */
  kwarg?: string;
  /** `system-prompt-line` / `prompt-soft-switch`: tier → the literal string to inject. */
  promptMap?: Partial<Record<EffortTier, string>>;
  promptSlot?: "system-append" | "user-append";
  constraints?: EffortConstraints;
  /** Reasoning arrives as inline text in these tags and must be stripped for display
   *  (Aider's `reasoning_tag`) — e.g. "think" for R1-style local models. */
  reasoningTag?: string;
  /** True when we are GUESSING support (llama.cpp/vLLM template kwargs are a silent no-op
   *  unless the template branches). Drives the "downgrade on first miss" probe path. */
  optimistic?: boolean;
  /** Shown to the user verbatim when we degrade. One sentence. */
  note?: string;
}

/**
 * How a tier is being honoured when no request parameter can carry it.
 *
 * Lives here rather than in `emulation.ts` (which owns the TABLE and the reasoning about which
 * techniques are admissible) so `EffortResolution` below can reference it without the two
 * modules importing each other.
 */
export interface EffortEmulation {
  /** the only technique in scope today — see `ai/effort/emulation.ts` for what is excluded. */
  via: "prompt-cot";
  /** the literal instruction that will be put in front of the model. */
  text: string;
}

/** Why an applied effort differs from the requested one. */
export type EffortDegradeReason =
  | "no-capability"
  | "always-on"
  | "tier-clamped"
  | "runtime-ignores"
  | "emulated"
  /**
   * The user said "send it anyway" (`--force-effort`) and we did, over this table's objection.
   *
   * A distinct reason rather than a silent success because the request may now be REJECTED —
   * `reasoning_effort` is a hard 400 on a GPT-4-class model, not a no-op — and the user needs
   * to be able to tell a forced knob from one this table vouched for.
   */
  | "forced";

/** What actually gets added to the outgoing request. */
export type EffortPatch =
  | { kind: "body"; path: string; value: unknown }
  | { kind: "kwarg"; name: string; value: unknown }
  | { kind: "prompt"; slot: "system-append" | "user-append"; text: string }
  | { kind: "none" };

/**
 * The result of resolving a tier against a capability. NEVER a bare string — the whole
 * point is that the caller (and the user) can tell the difference between "the model is
 * thinking harder" and "we asked nicely and nothing happened".
 *
 * INVARIANT: `applied !== requested` ⇒ `degraded !== null`.
 */
export interface EffortResolution {
  requested: EffortTier;
  /**
   * The tier actually in force, by ANY route.
   *
   * null ⇒ genuinely nothing is happening: the model reasons at a fixed depth we cannot move
   * (`always-on`), or the tier could not be expressed at all.
   *
   * Note what this deliberately does NOT mean: "no request parameter was sent". A tier carried
   * by `emulation` below has `patch: {kind:"none"}` — nothing goes on the wire — and is still
   * `applied`, because an instruction IS in front of the model and the answer WILL differ.
   * Reporting that as null was the misreport this field's doc used to encode: `/think high` on
   * a knobless model said "not available" while a graded instruction was being injected on
   * every single turn.
   */
  applied: EffortTier | null;
  mechanism: EffortMechanism;
  patch: EffortPatch;
  degraded: null | { reason: EffortDegradeReason; message: string };
  /**
   * Set when the tier is being honoured by INSTRUCTION rather than by a request parameter —
   * see `ai/effort/emulation.ts` for the technique and, more importantly, for the list of
   * things that are excluded from it on purpose.
   *
   * Two distinct cases carry this:
   *   - `degraded.reason === "emulated"` — prose is the ONLY thing in force (`mechanism:"none"`);
   *   - `degraded.reason === "runtime-ignores"` — a parameter WAS sent but the runtime may
   *     silently drop it (llama.cpp/vLLM template kwargs), so prose rides along as a backup.
   *
   * The consumer that puts this text in front of the model is the preamble pipeline's
   * `effort-text` contributor, NOT `applyEffortToMessages` — that one handles `patch.kind ===
   * "prompt"`, which is a different thing (a literal the model was TRAINED on, like gpt-oss's
   * `Reasoning: high`). Keeping them separate is what stops a model with its own prompt-shaped
   * knob from being told the same thing twice in two registers.
   */
  emulation?: EffortEmulation;
  /** Side-constraints the transport must honor (suppress temperature, raise max_tokens…). */
  constraints?: EffortConstraints;
}

/** Ladder index; -1 when not a tier. */
export function tierIndex(t: EffortTier): number {
  return EFFORT_TIERS.indexOf(t);
}

/**
 * Closest supported tier to `want`. Ties break DOWNWARD — a tie means we are equidistant
 * between a cheaper and a costlier option, and silently spending more of the user's money
 * (or their laptop's battery) is the worse surprise. Returns null when nothing is supported.
 */
export function nearestTier(want: EffortTier, supported: readonly EffortTier[]): EffortTier | null {
  if (supported.length === 0) return null;
  if (supported.includes(want)) return want;
  /**
   * `off` is a MODE, not the bottom of the ladder, and this is the one place that distinction
   * has teeth. On a two-value switch (`supported: ["off", "medium"]` — Qwen3's `/think` vs
   * `/no_think`, Nemotron's `detailed thinking on|off`) `low` is equidistant from both, and a
   * plain downward tie-break resolved it to `off`: asking for a LITTLE thinking turned thinking
   * OFF, and the rule's own comment claimed the opposite. Distance is the right metric among
   * degrees of thinking; it is the wrong metric across the boundary between thinking and not.
   */
  const pool =
    want === "off" || supported.every((t) => t === "off")
      ? supported
      : supported.filter((t) => t !== "off");
  const target = tierIndex(want);
  let best: EffortTier | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of pool) {
    const d = Math.abs(tierIndex(t) - target);
    // strict `<` keeps the FIRST of an equal pair; EFFORT_TIERS is ascending and `supported`
    // is normalised to that order by `rules.ts`, so the first equal hit is the lower tier.
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

/** Set a dotted path on a plain object, creating intermediate objects. Returns the same ref. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string;
    const next = cur[k];
    if (typeof next !== "object" || next === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
}
