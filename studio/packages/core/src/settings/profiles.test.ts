/**
 * profiles.test.ts — the profile layer that sits between global settings and the workspace.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { layerSettings } from "./layering.js";
import { sanitizeWorkspaceLayer } from "./posture.js";
import { DEFAULT_PROFILE_ID, resolveProfileLayer } from "./profiles.js";
import { DEFAULT_SETTINGS } from "./schema.js";

const deps = {
  defaults: DEFAULT_SETTINGS,
  layer: layerSettings,
  sanitize: sanitizeWorkspaceLayer,
};

test("an IMPLICIT profile may tighten the user's security posture but never widen it", () => {
  /**
   * `power-dev` is the fallback whenever `profileId` was never set — the shipped state for every
   * user who has not opened the profile picker — and it layers ABOVE global while hard-asserting
   * all four security keys with permissive values. So a user who wrote a strict posture into
   * their own settings.json had every one of those four values flipped back by a profile they
   * never chose. Measured before the fix: asked for all-strict, got all-permissive.
   *
   * The workspace layer already carried exactly this protection, and its comment explains why —
   * an unfiltered layer "would make the whole profile mechanism decorative one level down". An
   * unchosen default is the same problem one level up, so it reuses the same tighten-only filter.
   */
  const strictUser = {
    cloudModelsEnabled: false,
    defaultNetwork: "none",
    gateStrict: true,
    allowForce: false,
  };

  const implicit = resolveProfileLayer(strictUser, deps);
  assert.equal(implicit.implicit, true, "no profileId ⇒ the profile is implicit");
  assert.equal(implicit.profileId, DEFAULT_PROFILE_ID);

  const effective = layerSettings(DEFAULT_SETTINGS, strictUser as never, implicit.profile);
  assert.equal(effective.cloudModelsEnabled, false, "the user's cloud setting was overridden");
  assert.equal(effective.defaultNetwork, "none", "the user's network policy was widened");
  assert.equal(effective.gateStrict, true, "the user's strict gate was turned off");
  assert.equal(effective.allowForce, false, "the user's force ban was lifted");
  assert.deepEqual(
    [...implicit.refused].sort(),
    ["allowForce", "cloudModelsEnabled", "defaultNetwork", "gateStrict"],
    "every widening key must be refused, and named",
  );
});

test("an EXPLICITLY chosen profile is a decision and still wins over global", () => {
  const strictUser = {
    cloudModelsEnabled: false,
    defaultNetwork: "none",
    gateStrict: true,
    allowForce: false,
  };
  const chosen = { ...strictUser, profileId: "power-dev" };
  const explicit = resolveProfileLayer(chosen, deps);
  assert.equal(explicit.implicit, false);
  assert.deepEqual(explicit.refused, [], "an explicitly chosen profile is not filtered");

  const effective = layerSettings(DEFAULT_SETTINGS, chosen as never, explicit.profile);
  assert.equal(effective.gateStrict, false, "an explicit power-dev must still apply");
  assert.equal(effective.allowForce, true);
});

test("a user with no security keys of their own gets the default profile unchanged", () => {
  // The filter is one-way, not a bypass: with nothing to protect there is nothing to refuse.
  const bare = resolveProfileLayer({}, deps);
  assert.equal(bare.implicit, true);
  assert.deepEqual(bare.refused, []);
  const effective = layerSettings(DEFAULT_SETTINGS, {} as never, bare.profile);
  assert.equal(effective.cloudModelsEnabled, true, "the shipped default posture is unchanged");
});

test("an unknown profileId does not silently fall back to the permissive default", () => {
  const r = resolveProfileLayer({ profileId: "no-such-profile" }, deps);
  assert.equal(r.profile, undefined, "an unknown profile must contribute nothing");
});
