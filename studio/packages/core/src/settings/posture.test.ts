/**
 * posture.test.ts — the four security settings, and the promise they have to keep.
 *
 * These four keys shipped in the schema, were set by three named profiles, and were read by
 * nothing. A user picking "Local-only" — `cloudModelsEnabled: false`, `defaultNetwork: "none"` —
 * concluded that cloud calls were off. They were not. A control that does nothing is worse than
 * an absent one, because it is believed.
 *
 * So the tests that matter are the ones proving each key CHANGES A DECISION, and that the
 * tightening only ever goes one way: a session-level control may add a restriction and can never
 * remove one the policy imposed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cloudAllowed,
  describePosture,
  effectiveGateMode,
  egressAllowed,
  isRestrictive,
  sanitizeWorkspaceLayer,
  securityPosture,
} from "./posture.js";
import { getProfile } from "./profiles.js";
import { DEFAULT_SETTINGS } from "./schema.js";

/* ── the defaults must not change anyone's behaviour ────────────────────────*/

test("configuring nothing leaves everything permitted", () => {
  // Turning enforcement on must be a no-op for a user who never asked for a posture.
  const p = securityPosture(DEFAULT_SETTINGS);
  assert.equal(p.allowCloud, true);
  assert.equal(p.allowForce, true);
  assert.equal(p.minGateMode, "off", "a gate FLOOR of anything else would silently re-gate users");
  assert.equal(cloudAllowed("cloud", p).allowed, true);
  assert.equal(egressAllowed("model", p, { locality: "cloud" }).allowed, true);
});

test("undefined settings behave exactly like the defaults", () => {
  assert.deepEqual(securityPosture(undefined), securityPosture(DEFAULT_SETTINGS));
});

/* ── the shipped profiles ───────────────────────────────────────────────────*/

test("`local-only` actually stops cloud models — the headline claim", () => {
  const profile = getProfile("local-only");
  assert.ok(profile, "the local-only profile is gone");
  const p = securityPosture(profile?.settings);
  assert.equal(p.allowCloud, false);
  const decision = cloudAllowed("cloud", p);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /cloudModelsEnabled/);
});

test("`local-only` still permits a LOCAL model — the profile must not be a brick", () => {
  const p = securityPosture(getProfile("local-only")?.settings);
  assert.equal(p.network, "none");
  assert.equal(egressAllowed("model", p, { locality: "local" }).allowed, true);
  assert.equal(cloudAllowed("local", p).allowed, true);
});

test("`security-strict` raises the gate floor to enforce", () => {
  const p = securityPosture(getProfile("security-strict")?.settings);
  assert.equal(p.minGateMode, "enforce");
  assert.equal(p.allowForce, false);
  assert.equal(effectiveGateMode("off", p), "enforce", "the floor did not hold");
  assert.equal(effectiveGateMode("warn", p), "enforce");
});

test("`power-dev` is permissive and says so", () => {
  const p = securityPosture(getProfile("power-dev")?.settings);
  assert.equal(p.allowCloud, true);
  assert.equal(p.allowForce, true);
  assert.equal(p.minGateMode, "off");
});

/* ── the gate floor only tightens ───────────────────────────────────────────*/

test("the gate floor can RAISE a mode and can never lower one", () => {
  const strict = securityPosture({ gateStrict: true });
  const loose = securityPosture({ gateStrict: false });
  assert.equal(effectiveGateMode("off", strict), "enforce");
  assert.equal(effectiveGateMode("enforce", loose), "enforce", "a floor lowered a caller's gate");
  assert.equal(effectiveGateMode("warn", loose), "warn");
  assert.equal(effectiveGateMode(undefined, loose), "enforce", "an unset mode must default safe");
});

/* ── the session control may add, never remove ──────────────────────────────*/

test("a session checkbox can add the cloud restriction", () => {
  const permissive = securityPosture({ cloudModelsEnabled: true });
  const d = cloudAllowed("cloud", permissive, true);
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? "", /never send to cloud/);
});

test("a session that UNTICKS the box does not get cloud back", () => {
  // The whole point of a policy: the per-session control is not a way out of it.
  const locked = securityPosture({ cloudModelsEnabled: false });
  assert.equal(cloudAllowed("cloud", locked, false).allowed, false);
});

/* ── network policy ─────────────────────────────────────────────────────────*/

test('"none" blocks the web and remote MCP but not a local model', () => {
  const p = securityPosture({ defaultNetwork: "none" });
  assert.equal(egressAllowed("web", p).allowed, false);
  assert.equal(egressAllowed("mcp", p).allowed, false);
  assert.equal(egressAllowed("update", p).allowed, false);
  assert.equal(egressAllowed("model", p, { locality: "local" }).allowed, true);
  assert.equal(egressAllowed("model", p, { locality: "cloud" }).allowed, false);
});

test('"mcp-only" — the shipped default — permits connectors and refuses the open web', () => {
  const p = securityPosture({ defaultNetwork: "mcp-only" });
  assert.equal(egressAllowed("mcp", p).allowed, true);
  assert.equal(egressAllowed("model", p, { locality: "cloud" }).allowed, true);
  assert.equal(egressAllowed("web", p).allowed, false);
});

test('"allow" permits everything', () => {
  const p = securityPosture({ defaultNetwork: "allow" });
  for (const kind of ["model", "mcp", "web", "update"] as const) {
    assert.equal(egressAllowed(kind, p).allowed, true, `${kind} was blocked under "allow"`);
  }
});

test("a refusal NAMES the setting that caused it", () => {
  // "blocked" with no cause is how a user concludes the product is broken.
  const p = securityPosture({ defaultNetwork: "none" });
  assert.match(egressAllowed("web", p).reason ?? "", /defaultNetwork/);
});

test("an unknown defaultNetwork value falls back to the default, never to `allow`", () => {
  const p = securityPosture({ defaultNetwork: "sure-why-not" as never });
  assert.equal(p.network, "mcp-only");
});

/* ── reporting ──────────────────────────────────────────────────────────────*/

test("a restrictive posture is detectable and describable", () => {
  assert.equal(isRestrictive(securityPosture(DEFAULT_SETTINGS)), false);
  const p = securityPosture({
    cloudModelsEnabled: false,
    defaultNetwork: "none",
    gateStrict: true,
  });
  assert.equal(isRestrictive(p), true);
  const text = describePosture(p);
  assert.match(text, /cloud models off/);
  assert.match(text, /network: none/);
  assert.match(text, /gate ≥ enforce/);
});

/* ── the workspace layer is untrusted too ───────────────────────────────────*/

/**
 * `<repo>/.prometheus/settings.json` lives in the REPOSITORY and is the LAST layer, so it wins
 * over the global settings and over the active profile. That is the same supply-chain shape as
 * `.prometheus.toml`: opening a repo would otherwise be enough to undo a "Local-only" profile,
 * which makes the profile mechanism decorative one level further down.
 */

test("a repo cannot re-enable cloud models under a local-only profile", () => {
  const { layer, refused } = sanitizeWorkspaceLayer(
    { cloudModelsEnabled: true },
    { cloudModelsEnabled: false },
  );
  assert.equal("cloudModelsEnabled" in layer, false);
  assert.deepEqual(refused, ["cloudModelsEnabled"]);
});

test("a repo CAN turn cloud off for itself — tightening is the allowed direction", () => {
  const { layer, refused } = sanitizeWorkspaceLayer(
    { cloudModelsEnabled: false },
    { cloudModelsEnabled: true },
  );
  assert.equal(layer.cloudModelsEnabled, false);
  assert.deepEqual(refused, []);
});

test("a repo cannot widen the network policy, but can narrow it", () => {
  const widen = sanitizeWorkspaceLayer({ defaultNetwork: "allow" }, { defaultNetwork: "none" });
  assert.equal("defaultNetwork" in widen.layer, false);
  const narrow = sanitizeWorkspaceLayer({ defaultNetwork: "none" }, { defaultNetwork: "allow" });
  assert.equal(narrow.layer.defaultNetwork, "none");
});

test("an UNRECOGNISED network value is refused, not defaulted", () => {
  // Defaulting would resolve to "mcp-only" — a WIDENING when the base is "none".
  const { layer, refused } = sanitizeWorkspaceLayer(
    { defaultNetwork: "everything" },
    { defaultNetwork: "none" },
  );
  assert.equal("defaultNetwork" in layer, false);
  assert.deepEqual(refused, ["defaultNetwork"]);
});

test("a repo cannot lower the gate or restore force", () => {
  const g = sanitizeWorkspaceLayer({ gateStrict: false }, { gateStrict: true });
  assert.equal("gateStrict" in g.layer, false);
  const f = sanitizeWorkspaceLayer({ allowForce: true }, { allowForce: false });
  assert.equal("allowForce" in f.layer, false);
});

test("every NON-security key passes through untouched", () => {
  // This layer's real job is repo preferences. The fix must not turn it into a dead file.
  const { layer, refused } = sanitizeWorkspaceLayer(
    { theme: "dark", density: "compact", "format.onSave": true, todoPatterns: [] },
    { cloudModelsEnabled: false, defaultNetwork: "none", gateStrict: true, allowForce: false },
  );
  assert.deepEqual(layer, {
    theme: "dark",
    density: "compact",
    "format.onSave": true,
    todoPatterns: [],
  });
  assert.deepEqual(refused, []);
});

test("a workspace may restate what the base already permits", () => {
  const { layer, refused } = sanitizeWorkspaceLayer(
    { cloudModelsEnabled: true, gateStrict: false, allowForce: true },
    DEFAULT_SETTINGS,
  );
  assert.equal(layer.cloudModelsEnabled, true);
  assert.equal(layer.gateStrict, false);
  assert.equal(layer.allowForce, true);
  assert.deepEqual(refused, []);
});

test('a repo cannot widen network to "allow" even against the shipped DEFAULT', () => {
  // The default is "mcp-only", and it is not a user's expressed choice — so a repo asking for
  // open web access is widening beyond what anyone chose. A user who wants "allow" sets it
  // globally, where they can see it.
  const { layer, refused } = sanitizeWorkspaceLayer({ defaultNetwork: "allow" }, DEFAULT_SETTINGS);
  assert.equal("defaultNetwork" in layer, false);
  assert.deepEqual(refused, ["defaultNetwork"]);
});
