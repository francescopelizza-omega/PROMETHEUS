/**
 * hooks-panel.ts — pure Settings ▸ Lifecycle Hooks helpers.
 *
 * The settings loader (`packages/core/src/agent/hooks.ts` `validateHooks`/`isHookSpec`) is
 * ELEMENT-WISE fail-soft: a malformed row is silently DROPPED, not fatal — the right call for a
 * hand-edited settings.json, but the wrong one for a UI, where a save that silently loses the
 * row the user just typed reads as a bug. So this module validates PROACTIVELY and explains WHY
 * a draft would be rejected, while delegating the actual accept/reject DECISION to core's own
 * `isHookSpec` — the same function `validateHooks` calls — so the UI can never accept a row the
 * loader would go on to drop (zero drift by construction; see `isHookDraftValid`).
 *
 * PURE — no DOM, no IPC. Renderer-SANDBOXED (C5): imports only the pure
 * `@prometheus/core/agent-hooks` subpath (no node:*, per that module's own header).
 */
import {
  HOOK_EVENTS,
  type HookEvent,
  type HookSpec,
  isHookSpec,
} from "@prometheus/core/agent-hooks";

export { HOOK_EVENTS };
export type { HookEvent, HookSpec };

/** The Add/Edit form's field values — always strings (raw control state), unlike `HookSpec`. */
export interface HookDraft {
  event: string;
  matcher: string;
  command: string;
}

export const EMPTY_HOOK_DRAFT: HookDraft = { event: "PreToolUse", matcher: "", command: "" };

/** Load an existing spec into editable draft form. */
export function hookSpecToDraft(spec: HookSpec): HookDraft {
  return { event: spec.event, matcher: spec.matcher ?? "", command: spec.command };
}

/**
 * Build the `HookSpec` a draft would persist as: trims `command`, and trims+drops `matcher`
 * when empty (an empty/whitespace-only matcher means "every tool", so it is dropped rather than
 * persisted as `""` — mirrors `hookMatchesTool`'s own `m.trim()` check).
 */
export function draftToHookSpec(draft: HookDraft): HookSpec {
  const matcher = draft.matcher.trim();
  return {
    event: draft.event as HookEvent,
    command: draft.command.trim(),
    ...(matcher ? { matcher } : {}),
  };
}

/**
 * Human-readable reasons a draft would be REJECTED by the loader — proactive validation so the
 * user finds out at save time, not by watching a hook silently never fire. Every reason here
 * corresponds 1:1 to a condition in core's `isHookSpec`; `isHookDraftValid` below is the actual
 * gate, so these two can never disagree (asserted in the test file).
 */
export function validateHookDraft(draft: HookDraft): string[] {
  const errors: string[] = [];
  if (!(HOOK_EVENTS as readonly string[]).includes(draft.event)) {
    errors.push(`Event must be one of: ${HOOK_EVENTS.join(", ")}.`);
  }
  if (draft.command.trim().length === 0) {
    errors.push(
      "Command is required — a hook with a blank command line is dropped by the loader, not saved empty.",
    );
  }
  return errors;
}

/** The actual save gate: delegates to core's `isHookSpec` on the built spec (zero drift). */
export function isHookDraftValid(draft: HookDraft): boolean {
  return isHookSpec(draftToHookSpec(draft));
}

/** Replace the hook at `index` (append when omitted/out of range) — pure, immutable. */
export function upsertHook(rows: readonly HookSpec[], spec: HookSpec, index?: number): HookSpec[] {
  if (index === undefined || index < 0 || index >= rows.length) return [...rows, spec];
  const next = [...rows];
  next[index] = spec;
  return next;
}

/** Remove the hook at `index` — pure, immutable. */
export function removeHook(rows: readonly HookSpec[], index: number): HookSpec[] {
  return rows.filter((_, i) => i !== index);
}

/** One-line summary for a hook row's matcher (empty/absent ⇒ "every tool"). */
export function matcherLabel(spec: HookSpec): string {
  const m = spec.matcher?.trim();
  return m && m !== "*" ? m : "every tool";
}
