// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/default-server-setting.ts — the DEFAULT LOCAL MODEL SERVER (`/server`).
 *
 * Ollama unless the user picks another. Persisted in the SAME global settings blob as
 * `/timeout` (`~/.prometheus/config/settings.json`, `localModels.defaultServer`), which the app
 * reads and writes too (Settings → AI & Agents → Default Local Server), so both surfaces agree.
 * The rules for what the choice changes live in `@prometheus/core`'s `ai/default-server.ts`.
 */
import { ai } from "@prometheus/core";
import { loadSettings, saveSettings } from "../home.js";

/** The saved default (fail-soft: unreadable or invalid → Ollama). */
export function loadDefaultServer(home?: string): ai.DefaultServerId {
  try {
    return ai.defaultServerFrom(loadSettings(home));
  } catch {
    return ai.DEFAULT_SERVER;
  }
}

/** Persist a new default. Refuses anything that is not a known server id. */
export function saveDefaultServer(id: string, home?: string): boolean {
  if (!ai.isDefaultServerId(id)) return false;
  // false when settings.json could not be written — "✓ default server → X" with nothing saved
  // was the old report
  return saveSettings({ [ai.DEFAULT_SERVER_KEY]: id }, home);
}
