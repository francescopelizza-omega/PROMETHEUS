/**
 * settings/profiles.ts — the built-in profiles (file 09 §7.1).
 *
 * A profile is a named bundle of setting overrides. Three ship built-in:
 *   - Power-dev (default): cloud enabled, mcp-only egress, force allowed.
 *   - Security-strict: gate --strict, NO force, NO auto-approve.
 *   - Local-only: cloud models disabled, network none by default.
 * A profile switch is atomic + reversible — it just layers `settings` over the base
 * (settings/layering.ts). Persistence is the desktop main's job.
 */
import { deepMerge } from "./layering.js";
import type { Settings } from "./schema.js";

export interface Profile {
  id: string;
  label: string;
  builtin: boolean;
  settings: Partial<Settings>;
}

export const DEFAULT_PROFILE_ID = "power-dev";

export const BUILTIN_PROFILES: readonly Profile[] = Object.freeze([
  {
    id: "power-dev",
    label: "Power-dev",
    builtin: true,
    settings: {
      cloudModelsEnabled: true,
      defaultNetwork: "mcp-only",
      gateStrict: false,
      allowForce: true,
    },
  },
  {
    id: "security-strict",
    label: "Security-strict",
    builtin: true,
    settings: {
      gateStrict: true,
      allowForce: false,
      autoApprove: false,
      defaultNetwork: "mcp-only",
    },
  },
  {
    id: "local-only",
    label: "Local-only",
    builtin: true,
    settings: { cloudModelsEnabled: false, defaultNetwork: "none" },
  },
]);

const BY_ID = new Map<string, Profile>(BUILTIN_PROFILES.map((p) => [p.id, p]));

/** Look up a built-in profile by id (undefined for unknown). */
export function getProfile(id: string): Profile | undefined {
  return BY_ID.get(id);
}

/** Layer a profile's overrides over a base settings object (profile wins). */
export function applyProfile(base: Settings, profile: Profile): Settings {
  return deepMerge(base, profile.settings) as Settings;
}
