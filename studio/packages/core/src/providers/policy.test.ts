import assert from "node:assert/strict";
import { existsSync } from "node:fs";
/**
 * policy.test.ts — C11 provider promotion policy.
 *
 * Exercises classifyTier (incl. the conservative C->B promotion gate),
 * costLight, needsCostWarning, sortByPromotion (Tier-A first / escape-hatch
 * floats), the localai re-point helper, and a CONTRACT load of the REAL
 * config/providers.config.json (skips gracefully if absent).
 */
import { test } from "node:test";

import type { Provider } from "../domain/models.js";
import {
  DEFAULT_PROVIDERS_CONFIG,
  classifyTier,
  costLight,
  hasCoveringSubscription,
  loadProviders,
  loadProvidersSync,
  localaiRepointSuggestion,
  needsCostWarning,
  sortByPromotion,
} from "./policy.js";

function mk(p: Partial<Provider> & Pick<Provider, "id" | "label">): Provider {
  return {
    integrationKind: "first-party-api",
    billingMode: "metered",
    includedInSubscription: false,
    promotedTier: "C",
    costLight: "red",
    warn: "high",
    verifyAtSetup: true,
    ...p,
  };
}

const localP = mk({
  id: "local",
  label: "Local",
  integrationKind: "local-endpoint",
  billingMode: "free",
  promotedTier: "A",
  costLight: "green",
  warn: "none",
  isEscapeHatch: true,
  defaultBaseUrl: "http://localhost:11434/v1",
});
const copilot = mk({
  id: "copilot",
  label: "GitHub Copilot",
  integrationKind: "ide-subscription",
  billingMode: "subscription",
  includedInSubscription: true,
  promotedTier: "B",
  costLight: "blue",
  warn: "low",
});
const claude = mk({
  id: "claude",
  label: "Claude",
  promotedTier: "C",
  promotedTierIfSubscription: "B",
  subscriptionCoversIf: "claude-code-oauth",
  costLight: "red",
  costLightIfSubscription: "blue",
});

test("classifyTier: Tier-A and Tier-B providers pass through unchanged", () => {
  assert.equal(classifyTier(localP), "A");
  assert.equal(classifyTier(copilot), "B");
});

test("classifyTier: metered provider stays C WITHOUT a covering subscription", () => {
  assert.equal(classifyTier(claude), "C");
  assert.equal(classifyTier(claude, { coveredCapabilities: [] }), "C");
  // an unrelated capability must NOT promote it
  assert.equal(classifyTier(claude, { coveredCapabilities: ["something-else"] }), "C");
});

test("classifyTier: C->B promotion ONLY with the exact covering capability", () => {
  assert.equal(classifyTier(claude, { coveredCapabilities: ["claude-code-oauth"] }), "B");
});

test("classifyTier never promotes toward C (it only ever moves toward A)", () => {
  // A provider with no promotedTierIfSubscription can never move.
  const meteredNoPromo = mk({ id: "groq", label: "Groq", promotedTier: "C" });
  assert.equal(classifyTier(meteredNoPromo, { coveredCapabilities: ["anything"] }), "C");
});

test("costLight follows the EFFECTIVE tier (promoted C->B shows blue)", () => {
  assert.equal(costLight(localP), "green");
  assert.equal(costLight(copilot), "blue");
  assert.equal(costLight(claude), "red");
  assert.equal(costLight(claude, { coveredCapabilities: ["claude-code-oauth"] }), "blue");
});

test("needsCostWarning true only for effective Tier-C", () => {
  assert.equal(needsCostWarning(localP), false);
  assert.equal(needsCostWarning(copilot), false);
  assert.equal(needsCostWarning(claude), true);
  assert.equal(needsCostWarning(claude, { coveredCapabilities: ["claude-code-oauth"] }), false);
});

test("hasCoveringSubscription: includedInSubscription is unconditional", () => {
  assert.equal(hasCoveringSubscription(copilot), true);
  assert.equal(hasCoveringSubscription(claude), false);
  assert.equal(
    hasCoveringSubscription(claude, { coveredCapabilities: ["claude-code-oauth"] }),
    true,
  );
});

test("sortByPromotion: Tier-A first, escape-hatch floats to the very top", () => {
  const sorted = sortByPromotion([claude, copilot, localP]);
  assert.deepEqual(
    sorted.map((p) => p.id),
    ["local", "copilot", "claude"],
  );
  // input array is not mutated
  assert.deepEqual(
    [claude, copilot, localP].map((p) => p.id),
    ["claude", "copilot", "local"],
  );
});

test("sortByPromotion respects runtime promotion (claude promoted sorts before a Tier-C peer)", () => {
  const groq = mk({ id: "groq", label: "Groq", promotedTier: "C" });
  const sorted = sortByPromotion([groq, claude], { coveredCapabilities: ["claude-code-oauth"] });
  // claude is now B, groq stays C -> claude first
  assert.deepEqual(
    sorted.map((p) => p.id),
    ["claude", "groq"],
  );
});

test("localaiRepointSuggestion targets local with the engine localai command", () => {
  const s = localaiRepointSuggestion(claude, localP);
  assert.equal(s.fromProviderId, "claude");
  assert.equal(s.toProviderId, "local");
  assert.equal(s.defaultBaseUrl, "http://localhost:11434/v1");
  assert.deepEqual(s.engineCommand, ["localai", "--point", "http://localhost:11434/v1"]);
  assert.match(s.rationale, /Tier A/);
});

test("CONTRACT: real providers.config.json parses; local is Tier-A escape hatch", async (t) => {
  if (!existsSync(DEFAULT_PROVIDERS_CONFIG)) {
    t.skip(`providers config not present at ${DEFAULT_PROVIDERS_CONFIG}`);
    return;
  }
  const providers = await loadProviders();
  assert.ok(providers.length >= 5, "expected several providers");
  const local = providers.find((p) => p.id === "local");
  assert.ok(local, "local provider must exist");
  assert.equal(classifyTier(local!), "A");
  assert.equal(local?.isEscapeHatch, true);

  // sync loader agrees with async loader
  const sync = loadProvidersSync();
  assert.equal(sync.length, providers.length);

  // claude/chatgpt/gemini are metered Tier-C by default
  const c = providers.find((p) => p.id === "claude");
  if (c) {
    assert.equal(classifyTier(c), "C");
    assert.equal(needsCostWarning(c), true);
    // and promote to B with the declared seat capability
    const cap = c.subscriptionCoversIf;
    if (cap) assert.equal(classifyTier(c, { coveredCapabilities: [cap] }), "B");
  }
});
