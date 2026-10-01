// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/effort/rule-store.ts — adding the 40th model should be a data edit, not a code change.
 *
 * `rules.ts` opens by promising exactly that, and until now there was no way to keep it:
 * `resolveCapability(ctx, rules)` accepted an injected table and every caller in the repo used
 * the default. A model released next week meant editing TypeScript and shipping a build.
 *
 * ── WHY THE BUILTINS STAY IN CODE ──────────────────────────────────────────────────────────
 * The obvious reading of "externalise the table" is to move `builtinRules()` into the JSON file
 * wholesale. That is the wrong trade here, for two reasons:
 *
 *   1. `@prometheus/core/ai-effort` is imported by the Electron RENDERER across the C5
 *      boundary. It may not read files. A table that lives only on disk is a table half the
 *      surfaces cannot see.
 *   2. Two copies of one table is the exact failure this repo keeps finding — it is what
 *      `effort-text.ts` did with the prompt map, and it is why `/think` misreported for months.
 *
 * So the on-disk file holds OVERRIDES AND ADDITIONS ONLY, and ships empty. `builtinRules()`
 * remains the single seed; a user or workspace file is appended after it, and
 * `resolveCapability` already breaks a specificity tie in favour of the LATER rule — so
 * appending IS overriding, with no merge semantics to invent and nothing to drift.
 *
 * PURE. Parsing and layering only; a caller supplies the file contents (see the CLI's
 * `session/effort-rules.ts` for the disk half).
 */
import { buildPatch } from "./apply.js";
import type { EffortRule } from "./rules.js";
import { builtinRules } from "./rules.js";
import { isSafeSetPath } from "./types.js";
import type { EffortCapability, EffortMechanism, EffortTier } from "./types.js";
import { EFFORT_TIERS, isEffortTier } from "./types.js";

/** The file a user or workspace drops rules into. Same name at both layers. */
export const EFFORT_RULES_FILENAME = "effort-capabilities.json";

/** Every mechanism `apply.ts` can actually build a patch for. A file naming anything else is
 *  rejected rather than silently resolved to "no knob" at request time. */
const MECHANISMS: readonly EffortMechanism[] = [
  "effort-enum",
  "token-budget",
  "native-graded",
  "binary-toggle",
  "template-kwarg",
  "system-prompt-line",
  "prompt-soft-switch",
  "always-on",
  "none",
];

export interface ParsedEffortRules {
  rules: EffortRule[];
  /**
   * One sentence per rejected entry, naming the index and what was wrong.
   *
   * Returned rather than thrown: a malformed override must not take a session down, and it
   * must not vanish either — a rule the user believes is in force but which was silently
   * dropped is worse than no override at all. The host prints these.
   */
  errors: string[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function strings(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/** A tier list, in ladder order. Rejects an unknown tier rather than dropping it — a typo'd
 *  `"maximum"` that silently narrowed the supported set would be invisible. */
function tiers(v: unknown): { ok: true; value: EffortTier[] } | { ok: false; bad: string } {
  const list = strings(v);
  if (!list) return { ok: false, bad: "supported must be an array of strings" };
  const bad = list.find((t) => !isEffortTier(t));
  if (bad !== undefined) return { ok: false, bad: `unknown tier ${JSON.stringify(bad)}` };
  return { ok: true, value: EFFORT_TIERS.filter((t) => list.includes(t)) };
}

/**
 * Validate ONE rule. Returns the rule or the reason it was refused.
 *
 * Deliberately strict about the things that produce a SILENT wrong answer — an unknown
 * mechanism, an unknown tier, a `field`-less body mechanism — and permissive about the rest,
 * because `EffortCapability` is a wide optional-heavy shape and a validator that enumerated
 * every field would be a second definition of it to keep in sync.
 */
function parseRule(raw: unknown, index: number): { rule: EffortRule } | { error: string } {
  const at = `rule[${index}]`;
  if (!isRecord(raw)) return { error: `${at}: not an object` };
  const id = raw.id;
  if (typeof id !== "string" || id.trim() === "") return { error: `${at}: missing "id"` };
  if (!isRecord(raw.match)) return { error: `${at} (${id}): missing "match" object` };
  if (!isRecord(raw.cap)) return { error: `${at} (${id}): missing "cap" object` };

  const cap = raw.cap;
  const mechanism = cap.mechanism;
  if (typeof mechanism !== "string" || !(MECHANISMS as readonly string[]).includes(mechanism)) {
    return { error: `${at} (${id}): unknown mechanism ${JSON.stringify(mechanism)}` };
  }
  const sup = tiers(cap.supported);
  if (!sup.ok) return { error: `${at} (${id}): ${sup.bad}` };

  // A body-shaped mechanism with no `field` resolves to `{kind:"none"}` at request time — the
  // tier is accepted, nothing is sent, and nothing says so. Catch it here instead.
  const needsField =
    mechanism === "effort-enum" ||
    mechanism === "native-graded" ||
    mechanism === "binary-toggle" ||
    mechanism === "token-budget";
  if (needsField && typeof cap.field !== "string") {
    return { error: `${at} (${id}): mechanism "${mechanism}" requires a "field"` };
  }
  // A rules file can come from a project directory the user merely cloned. A `field` naming a
  // prototype-chain segment is a prototype-pollution attempt, not a typo — reject the rule by
  // name so it is visible, rather than silently dropping the patch at the sink.
  if (needsField && !isSafeSetPath(cap.field as string)) {
    return {
      error: `${at} (${id}): "field" may not contain __proto__, constructor or prototype`,
    };
  }
  if (mechanism === "template-kwarg" && typeof cap.kwarg !== "string") {
    return { error: `${at} (${id}): mechanism "template-kwarg" requires a "kwarg"` };
  }

  /**
   * Every SUPPORTED tier must actually produce a patch.
   *
   * The `field`/`kwarg` checks above catch two shapes of this; they do not catch the rest.
   * `effort-enum` with a `field` and no `enumMap`, `token-budget` with no `budgetMap`,
   * `prompt-soft-switch` with a `promptMap` that omits half its own `supported` set — each of
   * those parses, resolves, reports the tier as applied, and sends nothing at all. Asking the
   * real builder is the only check that cannot drift away from what the builder does.
   */
  const capForPatch = { ...(cap as unknown as EffortCapability), supported: sup.value };
  const dead = sup.value.filter((t) => buildPatch(t, capForPatch).kind === "none");
  if (dead.length > 0) {
    return {
      error: `${at} (${id}): mechanism "${mechanism}" produces nothing for ${dead
        .map((t) => JSON.stringify(t))
        .join(", ")} — the tier would report as applied while no setting reaches the model`,
    };
  }

  // Not a string ⇒ `String.prototype.startsWith` coerces it and matches by accident (`123`
  // becomes `"123"`), so a typo'd override matches models silently instead of being refused.
  const prefix = (raw.match as { modelIdPrefix?: unknown }).modelIdPrefix;
  if (prefix !== undefined && typeof prefix !== "string") {
    return { error: `${at} (${id}): modelIdPrefix must be a string` };
  }

  // A regex that does not compile would throw inside `resolveCapability`, on the request path.
  const rx = (raw.match as { modelIdRegex?: unknown }).modelIdRegex;
  if (rx !== undefined) {
    if (typeof rx !== "string") return { error: `${at} (${id}): modelIdRegex must be a string` };
    try {
      new RegExp(rx, "i");
    } catch {
      return { error: `${at} (${id}): modelIdRegex is not a valid regular expression` };
    }
  }

  return {
    rule: {
      id,
      match: raw.match as EffortRule["match"],
      cap: { ...(cap as unknown as EffortCapability), supported: sup.value },
    },
  };
}

/**
 * Parse one layer's file contents.
 *
 * Accepts either `{ "rules": [...] }` or a bare array, because both are things a person
 * reasonably writes and refusing one of them teaches nothing.
 */
export function parseEffortRules(raw: unknown): ParsedEffortRules {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.rules : undefined;
  if (list === undefined) return { rules: [], errors: [] };
  if (!Array.isArray(list)) {
    return { rules: [], errors: ['expected "rules" to be an array'] };
  }
  const rules: EffortRule[] = [];
  const errors: string[] = [];
  list.forEach((raw2, i) => {
    const out = parseRule(raw2, i);
    if ("rule" in out) rules.push(out.rule);
    else errors.push(out.error);
  });
  return { rules, errors };
}

/**
 * The effective table: builtins first, then each override layer in increasing precedence.
 *
 * Order IS the precedence, because `resolveCapability` scores specificity and breaks ties in
 * favour of the later rule. A workspace rule with the same match as a builtin therefore wins,
 * and one with a NARROWER match wins on specificity alone — no merge, no override key, nothing
 * to reason about beyond "later wins".
 */
export function layerEffortRules(...layers: readonly (readonly EffortRule[])[]): EffortRule[] {
  return [...builtinRules(), ...layers.flat()];
}
