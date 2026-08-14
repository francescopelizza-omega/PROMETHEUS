/**
 * cloud-endpoints.test.ts — an interactive session reaching a cloud model at all.
 *
 * The CLI's entire endpoint universe was two hardcoded LOCAL runners, so no cloud provider was
 * ever a candidate, `apiKeyRef` was always undefined, and the transport took its `Bearer local`
 * branch. Meanwhile the swarm lane reached sixteen cloud providers from the same registry, the
 * same env vars and the same keychain accounts — from one call site.
 *
 * The test that matters most is the negative one: a provider with NO key must not be offered.
 * Listing it would put a model in the picker that cannot answer, and the user would learn that
 * three seconds later as a 401 rather than immediately as "you have not configured that".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { API_PROVIDERS, type ApiProvider } from "../orchestration/api-providers.js";
import {
  describeCloudEndpoint,
  discoverCloudEndpoints,
  endpointForProvider,
  envKeyRef,
  keychainKeyRef,
  parseKeyRef,
  providerForBaseUrl,
} from "./cloud-endpoints.js";
import { DEFAULT_CONTEXT_WINDOW } from "./context-window.js";

const provider = (over: Partial<ApiProvider> = {}): ApiProvider =>
  ({
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    defaultModel: "llama-3.3-70b-versatile",
    models: [],
    automation: "full",
    confidence: "known",
    tosUrl: "",
    ...over,
  }) as ApiProvider;

/* ── discovery ─────────────────────────────────────────────────────────────*/

test("a provider with NO key is not offered as an endpoint", () => {
  // Offering it would put a model in the picker that cannot answer, and the failure would
  // arrive as a 401 seconds later instead of "you have not configured that".
  const out = discoverCloudEndpoints({ env: {}, providers: [provider()] });
  assert.deepEqual(out, []);
});

test("an env var makes a provider selectable, and names itself", () => {
  const out = discoverCloudEndpoints({
    env: { GROQ_API_KEY: "sk-x" },
    providers: [provider()],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.source, "env");
  assert.equal(out[0]?.envVar, "GROQ_API_KEY");
  assert.equal(out[0]?.endpoint.locality, "cloud");
  assert.equal(out[0]?.endpoint.apiKeyRef, "env:GROQ_API_KEY");
  assert.equal(out[0]?.endpoint.baseUrl, "https://api.groq.com/openai/v1");
});

test("the RAW key never appears on the endpoint — only a reference to it", () => {
  // The whole point of `apiKeyRef`: a resolved secret in JS state outlives the user revoking
  // it, survives into a core dump, and gets serialised by anything that logs the endpoint.
  const out = discoverCloudEndpoints({
    env: { GROQ_API_KEY: "sk-secret" },
    providers: [provider()],
  });
  assert.equal(JSON.stringify(out).includes("sk-secret"), false);
});

test("the keychain is the durable default, and an env var OVERRIDES it", () => {
  // Consistent with the swarm lane: an env var is an explicit, visible, per-invocation
  // override, and a user who exports one is telling you to use it.
  const keychainOnly = discoverCloudEndpoints({
    env: {},
    hasKeychainKey: (id) => id === "groq",
    providers: [provider()],
  });
  assert.equal(keychainOnly[0]?.source, "keychain");
  assert.equal(keychainOnly[0]?.endpoint.apiKeyRef, "keychain:provider:groq");

  const bothPresent = discoverCloudEndpoints({
    env: { GROQ_API_KEY: "sk-x" },
    hasKeychainKey: () => true,
    providers: [provider()],
  });
  assert.equal(bothPresent[0]?.source, "env", "the keychain shadowed an explicit env var");
});

test("several configured providers all appear, in registry order", () => {
  const out = discoverCloudEndpoints({
    env: { GROQ_API_KEY: "a", DEEPSEEK_API_KEY: "b" },
    providers: [
      provider(),
      provider({ id: "deepseek", label: "DeepSeek", apiKeyEnv: ["DEEPSEEK_API_KEY"] }),
    ],
  });
  assert.deepEqual(
    out.map((o) => o.providerId),
    ["groq", "deepseek"],
  );
});

/* ── the endpoint itself ───────────────────────────────────────────────────*/

test("the endpoint declares tool support and a conservative window", () => {
  const e = endpointForProvider(provider(), "env:X");
  assert.equal(e.supportsTools, true, "all three wire formats carry tools natively");
  // This fixture declares no window, so it gets the floor. Probing a cloud provider to find
  // one out is exactly what `probeContextWindow` refuses to do, so a real row states it —
  // see "a provider's DOCUMENTED window is used" below.
  assert.equal(e.contextWindow, 8192);
  assert.equal(e.model, "llama-3.3-70b-versatile");
});

/* ── the ref scheme ────────────────────────────────────────────────────────*/

test("both ref forms round-trip, and an unknown one is REFUSED rather than guessed", () => {
  assert.deepEqual(parseKeyRef(envKeyRef("OPENAI_API_KEY")), {
    kind: "env",
    envVar: "OPENAI_API_KEY",
  });
  assert.deepEqual(parseKeyRef(keychainKeyRef("groq")), {
    kind: "keychain",
    account: "provider:groq",
  });
  // Guessing would turn a bug in the endpoint that minted the ref into an opaque 401.
  assert.equal(parseKeyRef("sk-just-a-key"), null);
  assert.equal(parseKeyRef(""), null);
});

test("the description names WHERE the key came from, never the key", () => {
  const [info] = discoverCloudEndpoints({
    env: { GROQ_API_KEY: "sk-secret" },
    providers: [provider()],
  });
  const line = describeCloudEndpoint(info as never);
  assert.match(line, /\$GROQ_API_KEY/);
  assert.equal(line.includes("sk-secret"), false);
});

/* ── matching an endpoint back to its provider ─────────────────────────────*/

test("a base URL is matched back to its provider, tolerating slash and /v1 drift", () => {
  // The desktop's endpoint list comes from the engine and carries base URLs only — no provider
  // id, no key env var. Matching is the only way the app can know which key to use, and the
  // two sources disagree about trailing slashes and the /v1 suffix.
  const ps = [provider()];
  assert.equal(providerForBaseUrl("https://api.groq.com/openai/v1", ps)?.id, "groq");
  assert.equal(providerForBaseUrl("https://api.groq.com/openai/v1/", ps)?.id, "groq");
  assert.equal(providerForBaseUrl("https://API.groq.com/openai/v1", ps)?.id, "groq");
  assert.equal(providerForBaseUrl("https://api.groq.com/openai", ps)?.id, "groq");
});

test("an UNKNOWN host matches nothing, so the caller can leave it alone", () => {
  // A corporate gateway, a self-hosted proxy or an mTLS endpoint all work today with no key.
  // Claiming one of these belongs to a known provider would attach the wrong credential.
  assert.equal(providerForBaseUrl("https://llm.internal.example.com/v1", [provider()]), undefined);
  assert.equal(providerForBaseUrl("", [provider()]), undefined);
});

test("a longer path wins, so an aggregator does not swallow a sub-path provider", () => {
  const ps = [
    provider({ id: "host", label: "Host", baseUrl: "https://api.example.com" }),
    provider({ id: "sub", label: "Sub", baseUrl: "https://api.example.com/vendor/v1" }),
  ];
  assert.equal(providerForBaseUrl("https://api.example.com/vendor/v1", ps)?.id, "sub");
  assert.equal(providerForBaseUrl("https://api.example.com/other", ps)?.id, "host");
});

/* ── the context window, which decides whether a request is even attempted ──*/

test("a provider's DOCUMENTED window is used, not the 8192 floor", () => {
  // Every cloud endpoint was built with the floor from `ai/context-window.ts` — a number
  // meant for an unprobed LOCAL runner. That was harmless while it only sized the compaction
  // budget. `preflightContext` now REFUSES a request that does not fit, so on Claude (200k)
  // and Gemini (1M) an ordinary prompt with a couple of files in it was rejected before it
  // was sent, by a limit twenty-five times smaller than the model's real one.
  const anthropic = API_PROVIDERS.find((p) => p.id === "anthropic");
  assert.ok(anthropic, "the anthropic row is gone");
  assert.equal(endpointForProvider(anthropic, "ref").contextWindow, 200_000);

  const gemini = API_PROVIDERS.find((p) => p.id === "gemini");
  assert.ok(gemini);
  assert.equal(endpointForProvider(gemini, "ref").contextWindow, 1_048_576);
});

test("a provider with NO documented window still falls back to the floor", () => {
  // The fallback has to survive: a row added without a window must not produce `undefined`,
  // which `preflightContext` would read as a zero-token model and refuse everything.
  const { contextWindow: _drop, ...noWindow } = { ...provider(), contextWindow: undefined };
  assert.equal(
    endpointForProvider(noWindow as Parameters<typeof endpointForProvider>[0], "ref").contextWindow,
    DEFAULT_CONTEXT_WINDOW,
  );
});

test("EVERY provider that claims a window claims a plausible one", () => {
  // A typo here is a silent, expensive failure: too small refuses valid work, too large
  // trades a pre-flight refusal for a provider 400 mid-turn.
  for (const p of API_PROVIDERS) {
    if (p.contextWindow === undefined) continue;
    assert.ok(
      p.contextWindow >= 8192 && p.contextWindow <= 10_000_000,
      `${p.id} declares an implausible context window: ${p.contextWindow}`,
    );
  }
});
