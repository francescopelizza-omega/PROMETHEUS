/**
 * keymap-overrides.ts — the PURE container-side glue for the keymap rebind editor (APP-057).
 *
 * The renderer container (SettingsPanel) may reach core's PURE `@prometheus/core/keymap`
 * subpath (presets + override layer + conflict detection) — NOT the barrel (C5). This
 * module holds the small, node:test-able glue between the shell COMMAND REGISTRY (the LIVE,
 * rebindable command layer) and that core model: build the default "preset" layer from the
 * registry, resolve id→title for display, and project the persisted override list into the
 * `id → keys` map the live matcher (`handleChord`) reads. The React wiring + localStorage
 * IO stay in SettingsPanel/App (repo boundary); the transforms live here so they're tested.
 */
import type { KeyBinding } from "@prometheus/core/keymap";

import { SHELL_COMMANDS, chordToKeysString } from "../commands/registry.js";

/** localStorage keys + the same-tab change signal (localStorage 'storage' doesn't self-fire). */
export const KEYMAP_BASE_STORAGE = "prometheus.keymap.base";
export const KEYMAP_OVERRIDES_STORAGE = "prometheus.keymap.userBindings";
export const KEYMAP_CHANGED_EVENT = "prometheus:keymap-changed";

/**
 * The DEFAULT "preset" binding layer = every shell-registry command that ships a chord
 * (command id + registry keys string, source "preset"). This is the live default the user
 * overrides layer over; unbound commands aren't listed (nothing to rebind or reset).
 */
export function shellPresetBindings(): KeyBinding[] {
  return SHELL_COMMANDS.flatMap((c) =>
    c.keybinding
      ? [{ command: c.id, keys: chordToKeysString(c.keybinding), source: "preset" as const }]
      : [],
  );
}

/** The human title for a command id (for the Action column + conflict messages). */
export function commandTitle(id: string): string {
  return SHELL_COMMANDS.find((c) => c.id === id)?.title ?? id;
}

/**
 * Project the persisted override list → the `id → keys` map the live shell matcher reads
 * (`handleChord`'s `overrides`). Empty when there are no user rebinds.
 */
export function overridesToMap(overrides: readonly KeyBinding[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const o of overrides) map[o.command] = o.keys;
  return map;
}

/** Parse a persisted override JSON blob → KeyBinding[] (fail-soft: bad JSON → empty). */
export function parseOverrides(raw: string | null): KeyBinding[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (o): o is { command: unknown; keys: unknown } =>
          !!o &&
          typeof o === "object" &&
          typeof o.command === "string" &&
          typeof o.keys === "string",
      )
      .map((o) => ({ command: String(o.command), keys: String(o.keys), source: "user" as const }));
  } catch {
    return [];
  }
}
