// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * effort-pref.ts — which thinking-effort tier this extension runs at, and where it comes from.
 *
 * There was no answer at all: `vscodeTuning()` never set `tuning.effort`, so the `resolveEffort`
 * call in `llm.ts` always saw `undefined` and this surface sent no reasoning knob to any model,
 * ever. The CLI's `/think` and the desktop's chip both existed; the editor had neither.
 *
 * The rule, most specific first — the same shape `auth-level.ts` uses for the autonomy level:
 *
 *   1. `prometheus.effort`, when the user has EXPLICITLY set it (folder, workspace or global).
 *   2. the shared store, `~/.prometheus/config/effort.json`, so the tier chosen in the terminal
 *      or the app follows you into the editor.
 *   3. nothing — leave `tuning.effort` unset and let the model's own default stand. Deliberately
 *      NOT a hard-coded `medium`: inventing a tier nobody asked for would send a reasoning knob
 *      to every model on the strength of a default this file made up.
 */
import { cliProfiles } from "@prometheus/core";
import { isEffortTier } from "@prometheus/core/ai-effort";
import type { EffortTier } from "@prometheus/core/ai-effort";
import type * as vscode from "vscode";

/** The tier the user pinned in settings, or undefined when they never touched it. */
function explicitSetting(cfg: vscode.WorkspaceConfiguration): EffortTier | undefined {
  const probe = cfg.inspect<string>("effort");
  const pinned =
    probe?.workspaceFolderValue ?? probe?.workspaceValue ?? probe?.globalValue ?? undefined;
  return isEffortTier(pinned) ? pinned : undefined;
}

/**
 * Resolve the tier for a session, or undefined to leave the knob alone.
 *
 * `readShared` is injected so this is testable without touching a real home; production passes
 * the shared store from `@prometheus/core`.
 */
export function resolveEffortTier(
  cfg: vscode.WorkspaceConfiguration,
  readShared: () => EffortTier | null = defaultReadShared,
): EffortTier | undefined {
  return explicitSetting(cfg) ?? readShared() ?? undefined;
}

/**
 * Read the shared store, never throwing.
 *
 * A STATIC import, not a `require` — see the long note on `defaultReadShared` in `auth-level.ts`.
 * The lazy `require("@prometheus/core")` this replaces could never resolve in a CJS bundle (core
 * is ESM-only, with no `require` condition in its `exports` map, and is absent from the packaged
 * `.vsix` entirely), so precedence rule (2) was dead and the tier chosen in the terminal never
 * reached the editor. A failure here still means "no shared tier", not an error.
 */
function defaultReadShared(): EffortTier | null {
  try {
    return cliProfiles.readSavedEffort() ?? null;
  } catch {
    return null;
  }
}
