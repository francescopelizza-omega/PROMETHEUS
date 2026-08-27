/**
 * ai/effort/apply.ts — resolve a requested tier against a capability, then apply it.
 *
 * `resolveEffort` is the only place that decides what goes on the wire, and it upholds ONE
 * invariant: if what we applied differs from what the user asked for, the resolution says so.
 * That is the difference between this module and a naive passthrough — a passthrough turns
 * `/effort max` on a Gemma 3 into either an HTTP 400 or, worse, a comfortable silence.
 *
 * PURE. `applyEffort*` copy their inputs.
 */

import { emulationApplies, emulationFor } from "./emulation.js";
import type { EffortCapability, EffortPatch, EffortResolution, EffortTier } from "./types.js";
import { nearestTier, setPath } from "./types.js";

/** Extra context needed to honor provider bounds. */
export interface EffortContext {
  /**
   * The `max_tokens` this request will carry, when the caller already knows it.
   *
   * A PRE-clamp only. `applyEffort` re-clamps against the value actually present on the
   * assembled body and is the authoritative check — the agentic transports pass no
   * `maxTokens` at all and let `ai/wire.ts` substitute its own default, so a caller that
   * omits this is not thereby unprotected.
   */
  maxTokens?: number;
  /**
   * Send the knob even when this table says the model has none (`--force-effort`).
   *
   * The escape hatch for a model released after these rules were written, mirroring Aider's
   * `--no-check-model-accepts-settings`. OFF by default and loudly reported when used: the
   * whole point of this module is that a forwarded parameter is a 400 on GPT-4o and a silent
   * no-op on LM Studio, so overriding it is the user's call to make explicitly, once, rather
   * than the default anyone stumbles into.
   *
   * A no-op when the tier is already expressible — forcing something that works changes
   * nothing.
   */
  force?: boolean;
}

/**
 * What a FORCED effort sends when the table has nothing to offer.
 *
 * `reasoning_effort` with the OpenAI-compatible vocabulary, because that is the spelling every
 * shim that might quietly accept one understands, and because `off` has to become `"none"` —
 * `"off"` is not a value any of them take.
 */
const FORCED_FIELD = "reasoning_effort";
const FORCED_VOCAB: Record<EffortTier, string> = {
  off: "none",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

function forced(requested: EffortTier, cap: EffortCapability, why: string): EffortResolution {
  // Forcing changes what goes on the WIRE; it does not silence the preamble contributor, which
  // gates on `mechanism` alone and so still injects the prose for a `none` model. Reporting no
  // `emulation` here made the resolution disagree with what the turn actually carried — the
  // same report-vs-reality split this module was written to end.
  const emulation = emulationApplies(cap.mechanism) ? emulationFor(requested) : null;
  return {
    requested,
    applied: requested,
    mechanism: cap.mechanism,
    patch: { kind: "body", path: FORCED_FIELD, value: FORCED_VOCAB[requested] },
    degraded: {
      reason: "forced",
      message: `${why}; sent anyway because effort forcing is on — the provider may reject this request`,
    },
    ...(emulation ? { emulation } : {}),
    ...(cap.constraints ? { constraints: cap.constraints } : {}),
  };
}

function noop(
  requested: EffortTier,
  cap: EffortCapability,
  reason: "no-capability" | "always-on" | "runtime-ignores",
  message: string,
): EffortResolution {
  return {
    requested,
    applied: null,
    mechanism: cap.mechanism,
    patch: { kind: "none" },
    degraded: { reason, message },
    ...(cap.constraints ? { constraints: cap.constraints } : {}),
  };
}

/**
 * Decide what a requested tier means for this model.
 *
 * The outcomes are deliberately kept DISTINCT, because they mean different things to a user
 * deciding whether to switch models:
 *   - `always-on` → it always reasons and you cannot turn the dial. Nothing to do.
 *   - no knob     → no request parameter can carry the tier, so an INSTRUCTION does instead
 *                   (`emulated`). This is not "nothing happened": a graded line goes in front
 *                   of the model on every turn and the answer differs because of it.
 *   - LM Studio   → the model can reason, but this runtime swallows the request. Also emulated,
 *                   and the runtime's own sentence survives in the message so the user can tell
 *                   this case from a model that simply cannot think.
 */
export function resolveEffort(
  requested: EffortTier,
  cap: EffortCapability,
  ctx: EffortContext = {},
): EffortResolution {
  // The floor travels with the resolution, not just with the capability: `applyEffort` is the
  // only place that can see the real `max_tokens`, and all it gets handed is the resolution.
  const merged =
    cap.mechanism === "token-budget" && cap.budgetBounds
      ? {
          ...cap.constraints,
          budgetMin: cap.budgetBounds.min,
          // Whether the ceiling `applyEffort` will see belongs to the CALLER travels with the
          // resolution for the same reason the floor does: down there the wire's default and a
          // deliberate limit are the same number. See `ceilingFromCaller` in types.ts.
          ceilingFromCaller: ctx.maxTokens !== undefined,
        }
      : cap.constraints;
  const constraints = merged ? { constraints: merged } : {};

  if (cap.mechanism === "always-on") {
    if (ctx.force) {
      return forced(requested, cap, cap.note ?? "this model always reasons at a fixed depth");
    }
    // NOT emulated on purpose. The model already reasons at a fixed depth; a "think harder"
    // line cannot move it, so injecting one would spend tokens implying a control we lack.
    return noop(
      requested,
      cap,
      "always-on",
      cap.note ?? "this model always reasons at a fixed depth",
    );
  }
  if (cap.mechanism === "none" || cap.supported.length === 0) {
    if (ctx.force) {
      return forced(requested, cap, cap.note ?? "this model has no reasoning control");
    }
    /**
     * `emulationApplies` is the SAME predicate the preamble contributor gates on, and it has to
     * be, or this branch reports a lie. A `prompt-soft-switch` rule whose `supported` is empty
     * (an override can produce one) lands here: `emulationFor` returns text, we would report
     * `emulated`, and `effort-text.ts` would then decline to inject it because that mechanism
     * owns a prompt path of its own — tier reported as in force, nothing in front of the model.
     */
    const emulation = emulationApplies(cap.mechanism) ? emulationFor(requested) : null;
    if (emulation) {
      // The honesty fix. This used to return `applied: null` — "not available" — while
      // `agent/protocol/contributors/effort-text.ts` injected exactly this instruction on every
      // turn regardless. The tier IS in force; what is missing is a request PARAMETER, which is
      // what `patch: {kind:"none"}` says. `mechanism` still reports `none`, so a caller that
      // wants to know whether a knob exists is unaffected.
      return {
        requested,
        applied: requested,
        mechanism: cap.mechanism,
        patch: { kind: "none" },
        degraded: {
          reason: "emulated",
          message: `${cap.note ?? "this model has no reasoning control"}; using step-by-step prompting`,
        },
        emulation,
        ...constraints,
      };
    }
    // `off` on a knobless model: there is nothing to turn off, and the honest emulation of
    // "do not deliberate" is silence rather than a line asking the model to think less.
    const reason = cap.note?.includes("ignores") ? "runtime-ignores" : "no-capability";
    return noop(requested, cap, reason, cap.note ?? "this model has no reasoning control");
  }

  const applied = nearestTier(requested, cap.supported);
  if (applied === null) {
    return noop(requested, cap, "no-capability", cap.note ?? "this model has no reasoning control");
  }

  const degraded =
    applied === requested
      ? null
      : {
          reason: "tier-clamped" as const,
          message: cap.note
            ? `${cap.note}; ${requested} served as ${applied}`
            : `${requested} is not available on this model; served as ${applied}`,
        };

  const patch = buildPatch(applied, cap, ctx);

  // An optimistic mechanism (llama.cpp / vLLM template kwargs) is a coin flip: the flag is a
  // silent no-op unless the model's template branches on it. Say so rather than imply certainty.
  const finalDegraded =
    cap.optimistic && !degraded
      ? {
          reason: "runtime-ignores" as const,
          message:
            cap.note ?? "this runtime may ignore the setting depending on the model template",
        }
      : degraded;

  /**
   * A prose BACKUP for the coin-flip mechanisms — not a stand-in.
   *
   * The parameter was still sent (`patch` is a real kwarg), so the reason stays
   * `runtime-ignores`/`tier-clamped` rather than becoming `emulated`; the instruction rides
   * along in case the template never branches on the flag. Keyed on the REQUESTED tier, not the
   * applied one, because that is what the preamble contributor actually renders — llama.cpp's
   * `supported` is only `off|medium`, so `high` clamps, and the prose is the only thing that can
   * still express what the user asked for.
   */
  const emulation = cap.optimistic ? emulationFor(requested) : null;

  return {
    requested,
    applied,
    mechanism: cap.mechanism,
    patch,
    degraded: finalDegraded,
    ...(emulation ? { emulation } : {}),
    ...constraints,
  };
}

/**
 * The patch a tier produces on this capability — exported so `rule-store.ts` can VALIDATE
 * against the real builder rather than against a second, drifting list of which mechanism
 * needs which map. A tier whose patch is `{kind:"none"}` sends nothing while the resolution
 * reports it as applied, which is precisely what the parser has to refuse.
 */
export function buildPatch(
  tier: EffortTier,
  cap: EffortCapability,
  ctx: EffortContext = {},
): EffortPatch {
  switch (cap.mechanism) {
    case "effort-enum":
    case "native-graded": {
      if (!cap.field) return { kind: "none" };
      if (tier === "off" && cap.offValue !== undefined) {
        return { kind: "body", path: cap.field, value: cap.offValue };
      }
      const v = cap.enumMap?.[tier];
      if (v === undefined) return { kind: "none" };
      return { kind: "body", path: cap.field, value: v };
    }
    case "binary-toggle": {
      if (!cap.field) return { kind: "none" };
      const on = cap.onValue ?? true;
      const off = cap.offValue ?? false;
      return { kind: "body", path: cap.field, value: tier === "off" ? off : on };
    }
    case "token-budget": {
      if (!cap.field) return { kind: "none" };
      const b = cap.budgetBounds;
      if (tier === "off") {
        const dis = b?.disableWith;
        return dis === undefined ? { kind: "none" } : { kind: "body", path: cap.field, value: dis };
      }
      let n = cap.budgetMap?.[tier];
      if (n === undefined) return { kind: "none" };
      if (b) n = Math.min(Math.max(n, b.min), b.max);
      // Anthropic: budget_tokens must be strictly < max_tokens or the request 400s.
      if (cap.constraints?.budgetUnderMaxTokens && ctx.maxTokens !== undefined) {
        n = Math.min(n, Math.max(1, ctx.maxTokens - 1));
      }
      return { kind: "body", path: cap.field, value: n };
    }
    case "template-kwarg": {
      if (!cap.kwarg) return { kind: "none" };
      return { kind: "kwarg", name: cap.kwarg, value: tier !== "off" };
    }
    case "system-prompt-line":
    case "prompt-soft-switch": {
      const text = cap.promptMap?.[tier];
      if (text === undefined) return { kind: "none" };
      return { kind: "prompt", slot: cap.promptSlot ?? "system-append", text };
    }
    default:
      return { kind: "none" };
  }
}

/**
 * Apply a resolution's BODY/KWARG patch to an outgoing OpenAI-compatible request body.
 * Returns a new object; prompt patches are a no-op here (they belong to the message list —
 * see `applyEffortToMessages`).
 */
export function applyEffort(
  body: Record<string, unknown>,
  r: EffortResolution | undefined,
): Record<string, unknown> {
  if (!r) return body;
  // Omit rather than blank: a `temperature: undefined` key still satisfies `"temperature" in
  // body`, and callers (and tests) check presence, not value.
  const { temperature: currentTemp, ...rest } = body;
  const out: Record<string, unknown> = r.constraints?.noTemperature
    ? { ...rest }
    : { ...rest, ...(currentTemp !== undefined ? { temperature: currentTemp } : {}) };

  if (r.patch.kind === "body") {
    /**
     * Anthropic: `thinking.budget_tokens` must be strictly LESS than `max_tokens`, or the
     * request is a 400.
     *
     * Clamped HERE rather than only in `resolveEffort` because this is the first place that
     * can see the real number. `resolveEffort` takes `ctx.maxTokens` from its caller, and the
     * agentic CLI transport never passes one — the value that actually lands on the wire comes
     * from `ai/wire.ts`, which substitutes its own default when the caller omitted it. A
     * pre-clamp against a number nobody sent is not a clamp.
     */
    const budgetMin = r.constraints?.budgetMin;
    if (
      r.constraints?.budgetUnderMaxTokens &&
      budgetMin !== undefined &&
      typeof out.max_tokens === "number" &&
      out.max_tokens <= budgetMin
    ) {
      /**
       * The two constraints are jointly unsatisfiable at this `max_tokens`, and clamping alone
       * produced the very 400 the clamp exists to prevent: Claude 4.5's budget floor is 1024,
       * so a caller with `max_tokens: 512` got `budget_tokens: 511` — under the provider
       * minimum — and the request errored. Raising the ceiling is the only move that keeps
       * thinking on, and the provider requires it anyway for a budget of this size.
       */
      out.max_tokens = budgetMin + 1;
    }
    /**
     * How much of `max_tokens` the ANSWER keeps. Defaults to 1 — the bare `budget < max_tokens`
     * rule the provider enforces — so a capability that declares no headroom behaves exactly as
     * before. Claude 4.5 declares 4096, because `- 1` there left the reply one token.
     */
    const headroom = r.constraints?.budgetAnswerHeadroom ?? 1;
    const wanted = typeof r.patch.value === "number" ? r.patch.value : undefined;
    /**
     * The budget does not fit under the ceiling with the answer's share left over.
     *
     * WHICH ONE YIELDS depends on whose number the ceiling is. A caller that pinned
     * `max_tokens` set a hard cost limit and the budget must come down to fit inside it. A
     * ceiling WE substituted (`ai/wire.ts`'s 4096 when the agentic transport passes nothing)
     * is not a limit anyone asked for, and capping the tier against it is what made medium,
     * high and max produce byte-identical requests.
     */
    if (
      r.constraints?.budgetUnderMaxTokens &&
      wanted !== undefined &&
      typeof out.max_tokens === "number" &&
      out.max_tokens - wanted < headroom &&
      r.constraints.ceilingFromCaller !== true
    ) {
      out.max_tokens = wanted + headroom;
    }
    const budgetCap =
      r.constraints?.budgetUnderMaxTokens && typeof out.max_tokens === "number"
        ? Math.max(1, out.max_tokens - headroom)
        : undefined;
    const clamped =
      budgetCap !== undefined && wanted !== undefined ? Math.min(wanted, budgetCap) : r.patch.value;
    const value =
      budgetMin !== undefined && typeof clamped === "number"
        ? Math.max(clamped, budgetMin)
        : clamped;
    setPath(out, r.patch.path, value);
  } else if (r.patch.kind === "kwarg") {
    const prev = (out.chat_template_kwargs as Record<string, unknown> | undefined) ?? {};
    out.chat_template_kwargs = { ...prev, [r.patch.name]: r.patch.value };
  }
  // Remaining side-constraints that would otherwise 400 or be silently ignored.
  if (r.constraints?.pinTemperature !== undefined) out.temperature = r.constraints.pinTemperature;
  if (r.constraints?.minMaxTokens !== undefined) {
    const cur = typeof out.max_tokens === "number" ? out.max_tokens : 0;
    if (cur > 0 && cur < r.constraints.minMaxTokens) out.max_tokens = r.constraints.minMaxTokens;
  }
  return out;
}

/** A minimal message shape — structurally compatible with core's `Msg`. */
interface MsgLike {
  role: string;
  content: string;
}

/**
 * Apply a PROMPT patch (gpt-oss's `Reasoning: high`, Qwen3's `/no_think`) to a message list.
 * `system-append` folds into the first system message, creating one if absent, so the line
 * lands where the model was trained to read it. Returns a new array.
 */
export function applyEffortToMessages<T extends MsgLike>(
  messages: readonly T[],
  r: EffortResolution | undefined,
): T[] {
  if (!r || r.patch.kind !== "prompt") return [...messages];
  const { slot, text } = r.patch;
  const out = [...messages];
  if (slot === "system-append") {
    const i = out.findIndex((m) => m.role === "system");
    if (i >= 0) {
      const m = out[i] as T;
      out[i] = { ...m, content: `${m.content}\n${text}`.trim() };
    } else {
      out.unshift({ role: "system", content: text } as unknown as T);
    }
    return out;
  }
  // user-append: the LAST user turn is what the soft switch is scoped to.
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i] as T;
    if (m.role === "user") {
      out[i] = { ...m, content: `${m.content} ${text}`.trim() };
      return out;
    }
  }
  return out;
}

/**
 * One-line human summary for the composer badge and `/status`: the tier that is actually IN
 * FORCE, or `not available` when nothing is.
 *
 * `not available` is now a much narrower claim than it was: it means `always-on` (the depth is
 * fixed and unmovable) or `off` on a model with no knob. A model with no request parameter gets
 * the tier by instruction instead and reports the tier, because that is what is true.
 *
 * Deliberately carries no degradation marker. `~` already means "estimated" elsewhere in the
 * same chrome (the context meter's `~12.3k`, the cost ticker's `~$0.12`), so reusing it for
 * "clamped" would be ambiguous in the one place both can appear. Degradation is still
 * conveyed — by the badge's warn tint, and in full prose by `/effort` and `/status`.
 */
export function describeEffort(r: EffortResolution | undefined): string {
  if (!r) return "not available";
  if (r.applied === null) return "not available";
  return r.applied;
}
