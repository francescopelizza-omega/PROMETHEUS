// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { randomUUID } from "node:crypto";
/**
 * main/settings-store.ts — pure(ish) disk persistence + view-mapping for the settings
 * tree (file 13 §2.1/§2.7). Split out of settings-ipc.ts (which imports `electron` and
 * so can't be loaded by node:test — mirrors the mcp/store.ts + store.test.ts split) so
 * this stays unit-testable: node:fs/promises + @prometheus/core only, no Electron.
 *
 * Two atomic JSON layers — global (the SHARED `$PROMETHEUS_HOME/config/settings.json`,
 * the same file the CLI reads — see main/settings-path.ts) and workspace
 * (`<root>/.prometheus/settings.json`) — merge through core's `layerSettings()` with
 * the active BUILT-IN profile (a fixed bundle, not user-editable here) selected by the
 * global layer's `profileId`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { settings as coreSettings } from "@prometheus/core";

import type { SettingsRowView, SettingsUiScope } from "../shared/ipc-contract.js";

/** Read a JSON layer file; a missing/corrupt file is EMPTY (fail-soft, never throws). */
export async function readLayer(path: string): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Atomic write: temp file in the SAME directory + rename, so a crash mid-write never
 *  leaves a half-written layer file (rename is atomic within one filesystem). */
export async function writeLayerAtomic(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

/** The per-workspace layer file path (§7.1's 4th, highest-precedence layer). */
export function workspaceSettingsPath(root: string): string {
  return join(root, ".prometheus", "settings.json");
}

/**
 * A resolved row enriched with per-scope raw values + the full provenance chain (APP-058).
 * `rawByScope` carries ONLY the scopes that actually set the key (Object.hasOwn) so the UI
 * distinguishes "not set at this scope" from "set to a falsy value"; `definedIn` is every
 * layer that sets it, in precedence order (the "overrides User" chain).
 */
export interface SettingsRichRow {
  value: unknown;
  layer: coreSettings.SettingsLayerName;
  rawByScope: Partial<Record<SettingsUiScope, unknown>>;
  definedIn: coreSettings.SettingsLayerName[];
}

/** core provenance layer id → the contract's SettingsLayer name (defaults→default). */
const CORE_TO_VIEW_LAYER: Record<coreSettings.SettingsLayerId, coreSettings.SettingsLayerName> = {
  defaults: "default",
  global: "global",
  profile: "profile",
  workspace: "workspace",
};

/**
 * Resolve EVERY schemaKey-bearing tree node to a rich provenance row via core's pure
 * `explainKey` (defaults ◀ global ◀ profile ◀ workspace — the profile layer is now INCLUDED,
 * fixing the prior main-side bug that mislabeled profile-set keys "default"). `rawByScope`
 * reads the PRE-merge value at each EDITABLE UI scope (default/user/project) so the scope
 * tabs never show the merged effective value.
 */
export function resolveRichRows(
  global: Record<string, unknown>,
  profile: Record<string, unknown> | undefined,
  workspace: Record<string, unknown>,
): Map<string, SettingsRichRow> {
  const layers: coreSettings.SettingsLayerInput[] = [
    { id: "defaults", settings: coreSettings.DEFAULT_SETTINGS },
    { id: "global", settings: global as coreSettings.Settings },
    ...(profile
      ? [{ id: "profile" as const, settings: profile as Partial<coreSettings.Settings> }]
      : []),
    { id: "workspace", settings: workspace as coreSettings.Settings },
  ];
  const defaults = coreSettings.DEFAULT_SETTINGS;
  const out = new Map<string, SettingsRichRow>();
  for (const node of coreSettings.flattenTree()) {
    const key = node.schemaKey;
    if (!key) continue;
    const prov = coreSettings.explainKey(key, layers);
    const rawByScope: Partial<Record<SettingsUiScope, unknown>> = {};
    if (coreSettings.isSetAt(key, defaults))
      rawByScope.default = coreSettings.rawValueAt(key, defaults);
    if (coreSettings.isSetAt(key, global as coreSettings.Settings))
      rawByScope.user = coreSettings.rawValueAt(key, global as coreSettings.Settings);
    if (coreSettings.isSetAt(key, workspace as coreSettings.Settings))
      rawByScope.project = coreSettings.rawValueAt(key, workspace as coreSettings.Settings);
    out.set(key, {
      value: prov.effective,
      layer: prov.winner ? CORE_TO_VIEW_LAYER[prov.winner] : "unset",
      rawByScope,
      definedIn: prov.definedIn.map((l) => CORE_TO_VIEW_LAYER[l]),
    });
  }
  return out;
}

/** The minimal row shape toRowView reads (accepts both SettingsValueRow + SettingsRichRow). */
interface RowLike {
  value: unknown;
  layer: coreSettings.SettingsLayerName;
  rawByScope?: Partial<Record<SettingsUiScope, unknown>>;
  definedIn?: coreSettings.SettingsLayerName[];
}

/** Map one core SettingsNode (+ its resolved rows) to the renderer-safe SettingsRowView. */
export function toRowView(
  node: coreSettings.SettingsNode,
  rowsBySchemaKey: ReadonlyMap<string, RowLike>,
): SettingsRowView {
  const row = node.schemaKey ? rowsBySchemaKey.get(node.schemaKey) : undefined;
  return {
    id: node.id,
    title: node.title,
    category: node.category,
    ownerFile: node.ownerFile,
    control: node.control,
    ...(node.schemaKey ? { schemaKey: node.schemaKey } : {}),
    scope: node.scope,
    ...(node.searchTerms ? { searchTerms: node.searchTerms } : {}),
    // the closed value set for a `select` — without it the renderer falls back to a free
    // text input and the "choice" is a choice in name only.
    ...(node.options ? { options: node.options } : {}),
    ...(row ? { value: row.value, layer: row.layer } : {}),
    ...(row?.rawByScope ? { rawByScope: row.rawByScope } : {}),
    ...(row?.definedIn ? { definedIn: row.definedIn } : {}),
    ...(node.children ? { children: node.children.map((c) => toRowView(c, rowsBySchemaKey)) } : {}),
  };
}

export interface EffectiveLayers {
  effective: Record<string, unknown>;
  global: Record<string, unknown>;
  /** the active built-in profile's raw settings (undefined if none) — needed for provenance. */
  profile?: Record<string, unknown>;
  workspace: Record<string, unknown>;
}

/**
 * Load the global + workspace raw layers from disk and resolve the effective settings
 * object through core's layering (defaults ◀ global ◀ active-profile ◀ workspace). Returns
 * the profile layer too (APP-058) so per-key provenance can name the profile winner.
 */
export async function loadEffective(
  globalPath: string,
  workspaceRoot?: string,
): Promise<EffectiveLayers> {
  const global = await readLayer(globalPath);
  const workspace = workspaceRoot ? await readLayer(workspaceSettingsPath(workspaceRoot)) : {};
  // An IMPLICIT profile may only TIGHTEN the user's own posture — see `resolveProfileLayer`.
  const { profile } = coreSettings.resolveProfileLayer(global as Record<string, unknown>, {
    defaults: coreSettings.DEFAULT_SETTINGS,
    layer: coreSettings.layerSettings,
    sanitize: coreSettings.sanitizeWorkspaceLayer,
  });
  // The posture the USER chose: defaults ◀ global ◀ profile, before the repository gets a say.
  const userPosture = coreSettings.layerSettings(
    coreSettings.DEFAULT_SETTINGS,
    global as coreSettings.Settings,
    profile,
  );
  /**
   * The workspace layer is `<root>/.prometheus/settings.json` — it lives in the REPOSITORY and
   * arrives with the code, and it is the last layer, so it wins over the global settings and
   * over the active profile. Left unfiltered, opening a repo would be enough to undo a
   * "Local-only" profile, which would make the whole profile mechanism decorative one level
   * down. It may tighten the four security keys and nothing else.
   */
  const { layer: safeWorkspace } = coreSettings.sanitizeWorkspaceLayer(workspace, userPosture);
  const effective = coreSettings.layerSettings(
    coreSettings.DEFAULT_SETTINGS,
    global as coreSettings.Settings,
    profile,
    safeWorkspace as coreSettings.Settings,
  ) as unknown as Record<string, unknown>;
  return {
    effective,
    global,
    ...(profile ? { profile: profile as Record<string, unknown> } : {}),
    // The RAW workspace layer is returned for provenance display — the settings page should
    // still show what the file asked for, even where it was refused.
    workspace,
  };
}
