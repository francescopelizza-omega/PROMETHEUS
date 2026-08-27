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

/* ── the ACTIVE profile layer (APP-058 §7.1) ──────────────────────────────────── */

/**
 * Resolve the profile layer that sits above the user's global settings.
 *
 * A profile the user CHOSE may do anything, including loosen: picking "Power-dev" is a decision.
 * An IMPLICIT profile — the fallback used when `profileId` was never set, which is the shipped
 * state for every user who has not visited the profile picker — may only TIGHTEN.
 *
 * Without that distinction the default profile silently reverted the user's own security keys.
 * `power-dev` hard-asserts `cloudModelsEnabled: true`, `defaultNetwork: "mcp-only"`,
 * `gateStrict: false` and `allowForce: true`, and it layers ABOVE global, so a user who wrote
 * `{"gateStrict": true, "cloudModelsEnabled": false, "defaultNetwork": "none",
 * "allowForce": false}` into their own settings.json got all four values flipped back to the
 * permissive ones by a profile they never picked. Verified against the real layering before this
 * existed: user asked for all-strict, effective came back all-permissive.
 *
 * The workspace layer already had exactly this protection, for exactly this reason — the comment
 * on it says an unfiltered repo layer "would make the whole profile mechanism decorative one
 * level down". An unchosen default is the same problem one level up, so it reuses the same
 * tighten-only filter.
 */
export function resolveProfileLayer(
  global: Record<string, unknown>,
  deps: {
    defaults: Settings;
    layer: (defaults: Settings, global?: Settings, profile?: Partial<Settings>) => Settings;
    sanitize: (
      layer: Record<string, unknown>,
      base: Settings,
    ) => { layer: Record<string, unknown>; refused: string[] };
  },
): {
  profileId: string;
  implicit: boolean;
  profile: Partial<Settings> | undefined;
  refused: string[];
} {
  const chosen = typeof global.profileId === "string" ? global.profileId : undefined;
  const profileId = chosen ?? DEFAULT_PROFILE_ID;
  const found = getProfile(profileId)?.settings;
  if (chosen !== undefined || !found) {
    return { profileId, implicit: chosen === undefined, profile: found, refused: [] };
  }
  // implicit: it may tighten the user's posture, never widen it
  const userBase = deps.layer(deps.defaults, global as Settings);
  const { layer, refused } = deps.sanitize(found as Record<string, unknown>, userBase);
  return { profileId, implicit: true, profile: layer as Partial<Settings>, refused };
}
