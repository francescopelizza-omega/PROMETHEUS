/**
 * vendor-policy.test.ts — per-vendor automation stance (the corrected, non-Anthropic-only model).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { automationVerdict, vendorPolicyFor } from "./vendor-policy.js";

test("subscription stances match each vendor's actual terms", () => {
  assert.equal(vendorPolicyFor("claude")?.subscription, "forbidden");
  assert.equal(vendorPolicyFor("gemini")?.subscription, "forbidden"); // Google suspends OAuth driving
  assert.equal(vendorPolicyFor("codex")?.subscription, "discouraged");
  assert.equal(vendorPolicyFor("cursor")?.subscription, "allowed");
  assert.equal(vendorPolicyFor("aider")?.subscription, "byo-key");
  assert.equal(vendorPolicyFor("CURSOR")?.service, "cursor"); // case-insensitive
});

test("api-key + local are always allowed, regardless of vendor", () => {
  for (const svc of ["claude", "gemini", "codex", "cursor"]) {
    assert.equal(automationVerdict(svc, "api-key").severity, "ok", `${svc} api-key`);
  }
  assert.equal(automationVerdict("anything", "local").severity, "ok");
  assert.match(automationVerdict("ollama", "local").note, /favored/i);
});

test("subscription severity follows the per-vendor stance", () => {
  assert.equal(automationVerdict("claude", "subscription").severity, "block");
  assert.equal(automationVerdict("gemini", "subscription").severity, "block");
  assert.equal(automationVerdict("codex", "subscription").severity, "warn");
  assert.equal(automationVerdict("cursor", "subscription").severity, "ok");
  assert.equal(automationVerdict("cursor", "subscription").automationOk, true);
});

test("byo-key CLIs warn until a provider key is set; unknown vendor warns", () => {
  assert.equal(automationVerdict("aider", "subscription").severity, "warn");
  assert.match(automationVerdict("aider", "subscription").note, /provider/i);
  assert.equal(automationVerdict("aider", "api-key").severity, "ok");
  assert.equal(automationVerdict("totally-unknown", "unknown").severity, "warn");
});
