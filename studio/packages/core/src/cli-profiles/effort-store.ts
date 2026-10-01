// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * cli-profiles/effort-store.ts — the ONE saved thinking-effort tier, for every surface.
 *
 * `~/.prometheus/config/effort.json`, a flat `{ "tier": "off"|"low"|…|"max" }`, beside the saved
 * authorisation level, the profiles and `config.toml`.
 *
 * ## What is stored: the REQUEST, never the result
 *
 * This is the whole design, and it is what makes "re-apply the tier when the model changes"
 * fall out rather than needing a mechanism of its own.
 *
 * A tier means two different things at once. `xhigh` is what the operator ASKED for; it is also,
 * on a model whose vocabulary stops at `high`, not what gets sent. `ai/effort` already keeps the
 * two apart — `EffortResolution` carries `requested`, `applied` and a `degraded` explanation —
 * and only the REQUEST belongs on disk:
 *
 *   /think xhigh          on a local 8B model  → applied `high`, and `xhigh` is what is saved
 *   switch to Claude Opus 5                    → the saved `xhigh` resolves to `xhigh`
 *
 * Storing the applied value instead would ratchet the user permanently downward: one session on
 * a weak model would rewrite their preference to that model's ceiling, and switching back to a
 * capable one would answer at the ceiling of a model they are no longer using. That is exactly
 * the failure the authorisation level had — a session-scoped clamp persisting itself as a
 * preference — in a second setting.
 *
 * Fail-soft throughout: a missing or corrupt file reads as "unset", an unwritable home is a
 * no-op. Neither is a reason to refuse a session.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type EffortTier, isEffortTier } from "../ai/effort/types.js";
import { configDir, hasLegacyConfigDir, legacyConfigDir } from "./paths.js";

/** The store's file name, in whichever config root is in force. */
export const EFFORT_FILE = "effort.json";

/** `<config>/effort.json`. */
export function effortPath(home?: string): string {
  return join(configDir(home), EFFORT_FILE);
}

/**
 * The pre-consolidation location, still read.
 *
 * Present for the same reason the authorisation store has one: the config root moved to
 * `~/.prometheus/config`, the startup migration can fail on a read-only home, and a setting that
 * disappears during a move is indistinguishable from a setting that was never saved.
 */
export function legacyEffortPath(home?: string): string {
  return join(legacyConfigDir(home), EFFORT_FILE);
}

/** Parse one store file into a valid tier, or null when absent / corrupt / not a tier. */
function readTierAt(file: string): EffortTier | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && "tier" in parsed) {
      const raw = (parsed as { tier: unknown }).tier;
      // `isEffortTier` and not a length check: a tier saved by a NEWER build (one whose ladder
      // has a rung this one does not) must read as unset and fall back to the default, rather
      // than being forwarded to a provider as a value this build cannot reason about.
      if (isEffortTier(raw)) return raw;
    }
  } catch {
    /* fail-soft — never set / corrupt ⇒ unset */
  }
  return null;
}

/**
 * The saved tier, or null when the operator has never chosen one.
 *
 * The current root wins over the legacy one whenever it holds a valid value, so a stale copy at
 * the old path can never resurrect a tier the operator has since changed.
 *
 * The legacy fallback is SKIPPED when `$PROMETHEUS_HOME` is steering the home: the legacy root
 * resolves to the real OS home regardless, so reading it from inside a sandbox reached outside
 * that sandbox on every run and inherited the developer's real settings. See
 * `hasLegacyConfigDir`.
 */
export function readSavedEffort(home?: string): EffortTier | null {
  return (
    readTierAt(effortPath(home)) ??
    (hasLegacyConfigDir(home) ? readTierAt(legacyEffortPath(home)) : null)
  );
}

/**
 * Persist an EXPLICIT choice as the next session's default.
 *
 * Call with the tier the operator ASKED for. Never with `resolution.applied` — see the module
 * docblock for why that ratchets the preference down to whichever model happened to be bound.
 */
export function saveEffort(tier: EffortTier, home?: string): void {
  try {
    mkdirSync(configDir(home), { recursive: true });
    writeFileSync(effortPath(home), `${JSON.stringify({ tier }, null, 2)}\n`);
  } catch {
    /* best-effort — a read-only home must never crash the session */
  }
}
