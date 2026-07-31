/**
 * api-providers.test.ts — the own-key OpenAI-compatible provider registry + backend parsing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { orchestration as orch } from "../index.js";

test("the two user-named providers are present + reachable as backends", () => {
  assert.ok(orch.isApiProvider("nexos"));
  assert.ok(orch.isApiProvider("abacus"));
  assert.equal(orch.apiProviderFor("NEXOS")?.label, "nexos.ai"); // case-insensitive
  const abacus = orch.apiProviderFor("abacus");
  assert.match(abacus?.baseUrl ?? "", /abacus\.ai/);
  assert.equal(abacus?.automation, "verify-at-setup");
});

test("registry covers reputable hosts with OpenAI-compatible base URLs + key envs", () => {
  for (const id of [
    "together",
    "fireworks",
    "groq",
    "openrouter",
    "deepinfra",
    "mistral",
    "cerebras",
  ]) {
    const p = orch.apiProviderFor(id);
    assert.ok(p, `missing provider ${id}`);
    assert.match(p?.baseUrl ?? "", /^https:\/\//, `${id} baseUrl`);
    assert.ok((p?.apiKeyEnv.length ?? 0) > 0, `${id} key env`);
    assert.ok((p?.models.length ?? 0) > 0, `${id} models`);
  }
  // a clear API product is "allowed"; the China-region ones carry a data flag.
  assert.equal(orch.apiProviderFor("groq")?.automation, "allowed");
  assert.equal(orch.apiProviderFor("deepseek")?.dataRegion, "CN");
});

test("apiBackendFor builds a kind:api BackendRef with endpoint + key var", () => {
  const ref = orch.apiBackendFor("together");
  assert.equal(ref?.kind, "api");
  assert.equal(ref?.service, "together");
  assert.equal(ref?.apiKeyEnv, "TOGETHER_API_KEY");
  assert.match(ref?.baseUrl ?? "", /together\.xyz/);
  assert.ok((ref?.model ?? "").length > 0); // defaults to the provider's default model
  // model override is honored.
  assert.equal(
    orch.apiBackendFor("groq", "llama-3.3-70b-versatile")?.model,
    "llama-3.3-70b-versatile",
  );
  assert.equal(orch.apiBackendFor("not-a-provider"), null);
});

test("parseBackendRef resolves providers (bare, api:, and provider:model shorthands)", () => {
  assert.equal(orch.parseBackendRef("groq").kind, "api");
  assert.equal(orch.parseBackendRef("api:together").service, "together");
  const short = orch.parseBackendRef("together:meta-llama/Llama-3.3-70B-Instruct-Turbo");
  assert.equal(short.kind, "api");
  assert.equal(short.model, "meta-llama/Llama-3.3-70B-Instruct-Turbo");
  // a vendor CLI still wins over the api path; unknown tokens still fall back to local.
  assert.equal(orch.parseBackendRef("claude").kind, "cli");
  assert.equal(orch.parseBackendRef("some-random-model").kind, "local");
});

test("resolveApiKey reads the first present env var", () => {
  assert.equal(orch.resolveApiKey("together", { TOGETHER_API_KEY: "sk-x" })?.key, "sk-x");
  assert.equal(orch.resolveApiKey("deepinfra", { DEEPINFRA_TOKEN: "t" })?.env, "DEEPINFRA_TOKEN");
  assert.equal(orch.resolveApiKey("together", {}), null);
});

test("validateTopology requires a baseUrl for an api backend", () => {
  const bad = orch.normalizeTopology({
    orchestrator: "lead",
    agents: [{ name: "lead", backend: { kind: "api", service: "together" }, role: "x" }],
  });
  const v = orch.validateTopology(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /baseUrl/.test(e)));
  // with a baseUrl it validates.
  const good = orch.normalizeTopology({
    orchestrator: "lead",
    agents: [
      { name: "lead", backend: orch.apiBackendFor("together") ?? { kind: "fake" }, role: "x" },
    ],
  });
  assert.equal(orch.validateTopology(good).ok, true);
});
