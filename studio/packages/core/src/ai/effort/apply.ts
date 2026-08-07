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

import type { EffortCapability, EffortPatch, EffortResolution, EffortTier } from "./types.js";
import { nearestTier, setPath } from "./types.js";

/** Extra context needed to honor provider bounds. */
export interface EffortContext {
  maxTokens?: number;
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
 * The three "nothing happens" outcomes are deliberately kept DISTINCT, because they mean
 * different things to a user deciding whether to switch models:
 *   - `none`      → the model cannot reason at all;
 *   - `always-on` → it always reasons and you cannot turn the dial;
 *   - LM Studio   → the model can, but this runtime swallows the request.
 */
export function resolveEffort(
  requested: EffortTier,
  cap: EffortCapability,
  ctx: EffortContext = {},
): EffortResolution {
  const constraints = cap.constraints ? { constraints: cap.constraints } : {};

  if (cap.mechanism === "always-on") {
    return noop(
      requested,
      cap,
      "always-on",
      cap.note ?? "this model always reasons at a fixed depth",
    );
  }
  if (cap.mechanism === "none" || cap.supported.length === 0) {
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

  return {
    requested,
    applied,
    mechanism: cap.mechanism,
    patch,
    degraded: finalDegraded,
    ...constraints,
  };
}

function buildPatch(tier: EffortTier, cap: EffortCapability, ctx: EffortContext): EffortPatch {
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
    setPath(out, r.patch.path, r.patch.value);
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
 * One-line human summary for the composer badge and `/status`: the tier that was actually
 * APPLIED, or `not available` when nothing was sent.
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
