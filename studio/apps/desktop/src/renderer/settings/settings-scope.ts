/**
 * settings-scope.ts — PURE display/mapping helpers for the layered-scope settings UI
 * (APP-058). The scope tabs (Default / User / Project) and the provenance summary line are
 * driven by these node:test-able functions; SettingsTreePage is the thin React wrapper.
 *
 * Scope→layer is FIXED (§7.1): Default→defaults (read-only), User→global, Project→workspace.
 * The `profile` layer sits between User and Project with NO editable tab (a fixed bundle),
 * but stays in the provenance chain so effective values + "overrides …" read truthfully.
 */
import type { SettingsNodeView, SettingsUiScope } from "./settings-view.js";

type Layer = "default" | "global" | "profile" | "workspace" | "unset";

export interface ScopeTab {
  id: SettingsUiScope;
  label: string;
  /** Default is the shipped layer — read-only; only User/Project accept edits. */
  writable: boolean;
}

/** The scope tabs, lowest → highest editable precedence. */
export const SETTINGS_SCOPES: readonly ScopeTab[] = [
  { id: "default", label: "Default", writable: false },
  { id: "user", label: "User", writable: true },
  { id: "project", label: "Project", writable: true },
];

/** The persistence scope a UI scope writes to (null = read-only). */
export function scopeToWriteScope(scope: SettingsUiScope): "global" | "workspace" | null {
  return scope === "user" ? "global" : scope === "project" ? "workspace" : null;
}

const LAYER_LABEL: Record<Layer, string> = {
  default: "Default",
  global: "User",
  profile: "Profile",
  workspace: "Project",
  unset: "—",
};

/** Human label for a provenance layer ("global"→"User", "workspace"→"Project", …). */
export function layerLabel(layer: Layer | undefined): string {
  return layer ? LAYER_LABEL[layer] : "—";
}

/**
 * The RAW (pre-merge) value at one scope: whether the key is SET there (present, even if
 * falsy) + the value. Reads `node.rawByScope`, never the merged effective value — so a scope
 * tab correctly shows "not set" vs "set to false/0/''".
 */
export function rawAtScope(
  node: SettingsNodeView,
  scope: SettingsUiScope,
): { set: boolean; value: unknown } {
  const raw = node.rawByScope;
  if (raw && Object.hasOwn(raw, scope)) return { set: true, value: raw[scope] };
  return { set: false, value: undefined };
}

/** A short display string for a value (JSON for objects/arrays, "—" for undefined). */
export function displayValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/**
 * The provenance chain for the detail area: which layer wins + which lower layers it
 * overrides. A key only in defaults → "default"; an unset key → "not set"; otherwise
 * "set in <Winner>, overrides <lower layers>".
 */
export function provenanceSummary(node: SettingsNodeView): string {
  const winner = node.layer;
  if (!winner || winner === "unset") return "not set";
  const overridden = (node.definedIn ?? []).filter((l) => l !== winner);
  if (winner === "default" && overridden.length === 0) return "default";
  const overrides = overridden.length
    ? `, overrides ${overridden.map((l) => LAYER_LABEL[l]).join(" + ")}`
    : "";
  return `set in ${LAYER_LABEL[winner]}${overrides}`;
}
