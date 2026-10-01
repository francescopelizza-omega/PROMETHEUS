// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * cli-profiles/authorisation-store.ts — the ONE saved autonomy level, for every surface.
 *
 * `~/.prometheus/config/authorisation.json`, a flat `{ "level": 0..7 }`, beside the profiles,
 * `config.toml`, the grants and the token toggles.
 *
 * ## Why this lives in core
 *
 * It used to live in `apps/cli`, so it was the CLI's setting and nobody else's: the desktop kept
 * its own copy in renderer localStorage under `prometheus.authorisation.v1`, and the VS Code
 * extension had a THIRD one — a `prometheus.authLevel` setting on a 0..1 ladder that does not
 * even match core's 0..7. Setting A6 in the terminal changed nothing in the app, and clearing the
 * app's data silently reset the posture with no file to recover it from. One setting stored three
 * ways is not a setting; it is three settings that happen to share a name.
 *
 * ## What may write here
 *
 * ONLY an explicit, numbered choice by the operator — `/authorisation 6`, the GUI's level picker.
 * Restoring the level at startup, a `--authorisation` launch flag, a Shift-Tab through the coarse
 * permission modes, and the safety clamp after a declined sudo gate are all SESSION-scoped and
 * must never reach disk. Every one of them used to, and because mode→level is lossy (five modes,
 * eight levels) a deliberate `/authorisation 7` came back from the next session as 1.
 *
 * Fail-soft throughout: a missing or corrupt file reads as "unset" and an unwritable home is a
 * no-op, because neither is a reason to refuse a session.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { configDir, hasLegacyConfigDir, legacyConfigDir } from "./paths.js";

/** The store's file name, in whichever config root is in force. */
export const AUTH_LEVEL_FILE = "authorisation.json";

/** The lowest and highest levels the file may hold — the ladder's own bounds. */
const MIN_LEVEL = 0;
const MAX_LEVEL = 7;

/** `<config>/authorisation.json`. */
export function authLevelPath(home?: string): string {
  return join(configDir(home), AUTH_LEVEL_FILE);
}

/**
 * The pre-consolidation location, still READ.
 *
 * The config root moved from `~/.config/prometheus-studio` to `~/.prometheus/config`. A startup
 * migration copies the old tree across, but it can fail (a read-only home, a container) and it
 * has not run at all on the first launch of an upgraded install. Falling back here is what stops
 * the move from looking exactly like the bug it was made to fix.
 */
export function legacyAuthLevelPath(home?: string): string {
  return join(legacyConfigDir(home), AUTH_LEVEL_FILE);
}

/** Parse one store file into a valid level, or null when absent / corrupt / out of range. */
function readLevelAt(file: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && "level" in parsed) {
      const raw = (parsed as { level: unknown }).level;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        const n = Math.trunc(raw);
        if (n >= MIN_LEVEL && n <= MAX_LEVEL) return n;
      }
    }
  } catch {
    /* fail-soft — never set / corrupt ⇒ unset */
  }
  return null;
}

/**
 * The saved level 0–7, or null when never set / unreadable.
 *
 * The current root wins over the legacy one whenever it holds a valid value, so a stale copy at
 * the old path can never resurrect a level the operator has since changed.
 *
 * The legacy fallback is SKIPPED when `$PROMETHEUS_HOME` is steering the home: the legacy root
 * resolves to the real OS home regardless, so reading it from inside a sandbox reached outside
 * that sandbox on every run and inherited the developer's real settings. See
 * `hasLegacyConfigDir`.
 */
export function readSavedAuthLevel(home?: string): number | null {
  return (
    readLevelAt(authLevelPath(home)) ??
    (hasLegacyConfigDir(home) ? readLevelAt(legacyAuthLevelPath(home)) : null)
  );
}

/** Persist an EXPLICIT choice as the next-session default (creates the config dir). */
export function saveAuthLevel(level: number, home?: string): void {
  const n = Math.max(MIN_LEVEL, Math.min(Math.trunc(level), MAX_LEVEL));
  try {
    mkdirSync(configDir(home), { recursive: true });
    writeFileSync(authLevelPath(home), `${JSON.stringify({ level: n }, null, 2)}\n`);
  } catch {
    /* best-effort — a read-only home must never crash the session */
  }
}
