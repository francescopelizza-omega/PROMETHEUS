// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * settings/layering.ts — the §7.1 config precedence (PURE deep-merge).
 *
 *   defaults  ◀  global (~/.prometheus-studio/settings.json)  ◀  profile  ◀  workspace
 *   lowest                                                                     highest
 *
 * Deep-merge so nested objects compose (a workspace override of one nested key does
 * not wipe its siblings). Arrays + scalars REPLACE (last layer wins). Persistence
 * (reading/writing the JSON files) is the desktop main's job; this is pure logic.
 */
import type { Settings } from "./schema.js";

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge plain objects left→right (later wins; nested records merge; arrays replace). */
export function deepMerge(
  ...layers: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!isPlainRecord(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      const prev = out[key];
      out[key] = isPlainRecord(prev) && isPlainRecord(value) ? deepMerge(prev, value) : value;
    }
  }
  return out;
}

/**
 * Resolve effective settings from the four layers in §7.1 precedence. `profile` is a
 * partial (a profile only overrides some keys); absent layers are skipped.
 */
export function layerSettings(
  defaults: Settings,
  global?: Settings,
  profile?: Partial<Settings>,
  workspace?: Settings,
): Settings {
  return deepMerge(defaults, global, profile, workspace) as Settings;
}

/* ── per-key provenance (APP-058 layered scope UI) ─────────────────────────── */

/** The §7.1 layers in precedence order (lowest ◀ highest). UI scopes map: default→defaults,
 *  user→global, project→workspace; `profile` sits between and may have no UI tab. */
export type SettingsLayerId = "defaults" | "global" | "profile" | "workspace";

/** One layer's raw (pre-merge) settings, tagged with its layer id. */
export interface SettingsLayerInput {
  id: SettingsLayerId;
  settings?: Partial<Settings>;
}

/**
 * Flatten settings into dotted LEAF keys. Mirrors `deepMerge`'s traversal EXACTLY so
 * provenance never drifts from the effective value: recurse only into plain records
 * (nested objects compose), and treat arrays + scalars + null as a SINGLE leaf (per §7.1
 * arrays REPLACE wholesale — never per-index keys). An `undefined` value is skipped ("not
 * set", same as deepMerge); `null`/`0`/`""`/`false` are real, kept leaves.
 */
export function flattenSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (isPlainRecord(value)) walk(value, path);
      else out[path] = value;
    }
  };
  if (isPlainRecord(settings)) walk(settings, "");
  return out;
}

/** The provenance of one dotted key across the layers. */
export interface KeyProvenance {
  /** the winning leaf value (undefined only when the key is set in NO layer). */
  effective: unknown;
  /** every layer that sets the key, in precedence order (lowest ◀ highest). */
  definedIn: SettingsLayerId[];
  /** the highest-precedence layer that sets it (undefined when unset everywhere). */
  winner?: SettingsLayerId;
}

/**
 * Explain one dotted key across the ordered layers (defaults ◀ global ◀ profile ◀ workspace):
 * which layers set it, which one wins, and the effective value — computed via the SAME
 * `flattenSettings` so it can never diverge from `layerSettings`'s merge. Distinguishes
 * "key absent" (not in `definedIn`) from "key set to a falsy value" (present, value falsy),
 * so a User `false` correctly wins over a Default `true`.
 */
export function explainKey(path: string, layers: readonly SettingsLayerInput[]): KeyProvenance {
  const definedIn: SettingsLayerId[] = [];
  let winner: SettingsLayerId | undefined;
  let effective: unknown;
  for (const layer of layers) {
    const flat = flattenSettings(layer.settings as Record<string, unknown> | undefined);
    if (Object.hasOwn(flat, path)) {
      definedIn.push(layer.id);
      winner = layer.id;
      effective = flat[path];
    }
  }
  return { effective, definedIn, ...(winner ? { winner } : {}) };
}

/** The raw (pre-merge) value of `path` at ONE layer, or undefined when unset there — the
 *  per-scope value a scope tab shows (never the merged effective value). */
export function rawValueAt(
  path: string,
  settings: Partial<Settings> | undefined,
): unknown | undefined {
  const flat = flattenSettings(settings as Record<string, unknown> | undefined);
  return Object.hasOwn(flat, path) ? flat[path] : undefined;
}

/** True when `path` is set (present, value !== undefined) at this layer. */
export function isSetAt(path: string, settings: Partial<Settings> | undefined): boolean {
  return Object.hasOwn(flattenSettings(settings as Record<string, unknown> | undefined), path);
}
