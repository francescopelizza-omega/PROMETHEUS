// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/idle-timeout-setting.ts — the user-configurable INACTIVITY-PAUSE threshold.
 *
 * Default 10 minutes (`agent.idleWatchdog.DEFAULT_IDLE_TIMEOUT_MS` — the single source of
 * truth, shared with Desktop). Reachable via `/timeout` (see slash-registry.ts). Persisted in
 * the SAME global settings blob `apps/cli/src/home.ts` already owns
 * (`~/.prometheus/config/settings.json`) — one more key, no new file, no new store, exactly
 * like `context-window-setting.ts`.
 */
import { agent } from "@prometheus/core";
import { loadSettings, saveSettings } from "../home.js";

const SETTINGS_KEY = "idleTimeoutMs";

/** The `/timeout` menu — a numbered pick in minutes, mirroring `/context window`'s presets. */
export const IDLE_TIMEOUT_PRESETS_MIN: readonly number[] = Object.freeze([1, 2, 5, 10, 15, 30, 60]);

/** `"10"` / `"10m"` / `"600s"` / `"1h"` → ms, or null when unparseable / out of range.
 *  A bare number is read as MINUTES (the unit `/timeout`'s prompt and preset menu both use). */
export function parseIdleTimeoutInput(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(h|m|min|s)?$/.exec(s);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const unit = m[2];
  const ms = unit === "h" ? base * 3_600_000 : unit === "s" ? base * 1_000 : base * 60_000; // bare/m/min ⇒ minutes
  const n = Math.round(ms);
  return n >= agent.idleWatchdog.MIN_IDLE_TIMEOUT_MS && n <= agent.idleWatchdog.MAX_IDLE_TIMEOUT_MS
    ? n
    : null;
}

/** The active idle-pause threshold, in ms — the saved setting, or the 10-minute default.
 *  Fail-soft. */
export function loadIdleTimeoutMs(home: string): number {
  const raw = loadSettings(home)[SETTINGS_KEY];
  return typeof raw === "number" &&
    raw >= agent.idleWatchdog.MIN_IDLE_TIMEOUT_MS &&
    raw <= agent.idleWatchdog.MAX_IDLE_TIMEOUT_MS
    ? raw
    : agent.idleWatchdog.DEFAULT_IDLE_TIMEOUT_MS;
}

/** Persist a new threshold (clamped defensively — the caller should already have validated via
 *  `parseIdleTimeoutInput`/the preset menu, but a direct programmatic caller gets the same
 *  floor/ceiling either way). */
export function saveIdleTimeoutMs(home: string, ms: number): void {
  saveSettings({ [SETTINGS_KEY]: agent.idleWatchdog.clampIdleTimeoutMs(ms) }, home);
}
