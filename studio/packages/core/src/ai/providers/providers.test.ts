/**
 * providers.test.ts — the matrix loader + the 3-tier policy + the wiring guards
 * (file 12 §1–§3). No framework: node:test + the dev-register loader.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ConnectorConfig,
  type Pricing,
  type Provider,
  contextLenForModel,
  costLightForTier,
  costOf,
  detectKeyShadowsOauth,
  effectiveTier,
  getProvider,
  loadPricing,
  loadProviders,
  newConnector,
  priceForModel,
  resolveBrain,
  sortByPromotion,
  validateConnector,
  validateProvider,
  warnForTier,
} from "./index.js";

// ---- the shipped matrix ---------------------------------------------------- //

test("loadProviders reads the shipped 10-row matrix", () => {
  const providers = loadProviders();
  assert.equal(providers.length, 10);
  for (const id of [
    "local",
    "generic-openai-compatible",
    "open-weight-api-host",
    "nexos",
    "abacus",
    "claude",
    "chatgpt",
    "gemini",
    "copilot",
    "cursor",
  ]) {
    assert.ok(getProvider(providers, id), `expected provider ${id}`);
  }
});

test("loadProviders is fail-soft on a missing path", () => {
  assert.deepEqual(loadProviders("/no/such/providers.config.json"), []);
});

test("claude carries §3.1 model prices and the oauth flow", () => {
  const claude = getProvider(loadProviders(), "claude");
  assert.ok(claude);
  assert.ok(claude?.oauth, "claude must have an oauth descriptor");
  assert.equal(claude?.oauth?.betaHeader, "oauth-2025-04-20");
  const opus = claude?.models?.find((m) => m.id === "claude-opus-4-8");
  assert.equal(opus?.pricePerMTokIn, 5);
  assert.equal(opus?.pricePerMTokOut, 25);
});

// ---- the tier/light/warn derivation (§1.1) -------------------------------- //

test("the connector kind decides the effective tier", () => {
  assert.equal(effectiveTier("local-serve"), "A");
  assert.equal(effectiveTier("oauth-subscription-bridge"), "B");
  assert.equal(effectiveTier("cli-passthrough"), "B");
  assert.equal(effectiveTier("api-key"), "C");
});

test("the tier decides the cost light and the warn level", () => {
  assert.equal(costLightForTier("A"), "green");
  assert.equal(costLightForTier("B"), "blue");
  assert.equal(costLightForTier("C"), "red");
  assert.equal(warnForTier("A"), "none");
  assert.equal(warnForTier("B"), "gentle");
  assert.equal(warnForTier("C"), "loud");
});

test("sortByPromotion is A before B before C", () => {
  const sorted = sortByPromotion(loadProviders());
  const tiers = sorted.map((p) => p.tier);
  const firstC = tiers.indexOf("C");
  const lastA = tiers.lastIndexOf("A");
  const lastB = tiers.lastIndexOf("B");
  assert.ok(lastA < tiers.indexOf("B"), "all A before any B");
  assert.ok(lastB < firstC || firstC === -1, "all B before any C");
});

// ---- validateProvider fail-soft -------------------------------------------- //

test("validateProvider drops rows missing required fields", () => {
  assert.equal(validateProvider({ id: "x" }), null); // no label
  assert.equal(validateProvider({ id: "x", label: "X", kinds: [] }), null); // no kinds
  assert.equal(
    validateProvider({
      id: "x",
      label: "X",
      kinds: ["bogus"],
      billing: "metered",
      tier: "C",
      costLight: "red",
      warnLevel: "loud",
    }),
    null,
  ); // bad kind -> empty -> null
  const ok = validateProvider({
    id: "x",
    label: "X",
    kinds: ["api-key"],
    billing: "metered",
    tier: "C",
    costLight: "red",
    warnLevel: "loud",
  });
  assert.ok(ok);
  assert.equal(ok?.verifyAtSetup, true);
});

// ---- resolveBrain Tier-A-first (§3) --------------------------------------- //

const PROVIDERS = loadProviders();

function connector(
  over: Partial<ConnectorConfig> & Pick<ConnectorConfig, "providerId" | "kind">,
): ConnectorConfig {
  const provider = getProvider(PROVIDERS, over.providerId) as Provider;
  const base = newConnector(
    provider,
    over.kind,
    over.modelId ?? provider.models?.[0]?.id ?? "default",
    over.enabledFor ?? ["agent-pane"],
  );
  return { ...base, ...over };
}

test("resolveBrain prefers Tier A even when B and C are present", () => {
  const connectors: ConnectorConfig[] = [
    connector({
      providerId: "open-weight-api-host",
      kind: "api-key",
      modelId: "deepseek-chat",
      confirmedCostWarningAt: "2026-06-01",
    }),
    connector({
      providerId: "claude",
      kind: "oauth-subscription-bridge",
      modelId: "claude-sonnet-4-6",
    }),
    connector({ providerId: "local", kind: "local-serve", modelId: "qwen3:8b" }),
  ];
  const r = resolveBrain(connectors, "agent-pane");
  assert.equal(r?.tier, "A");
  assert.equal(r?.connector.providerId, "local");
});

test("resolveBrain falls to B then C as tiers drop out", () => {
  const b = resolveBrain(
    [
      connector({
        providerId: "claude",
        kind: "oauth-subscription-bridge",
        modelId: "claude-sonnet-4-6",
      }),
    ],
    "agent-pane",
  );
  assert.equal(b?.tier, "B");
  const c = resolveBrain(
    [
      connector({
        providerId: "open-weight-api-host",
        kind: "api-key",
        modelId: "deepseek-chat",
        confirmedCostWarningAt: "2026-06-01",
      }),
    ],
    "agent-pane",
  );
  assert.equal(c?.tier, "C");
});

test("resolveBrain returns null when nothing is enabled for the surface", () => {
  const r = resolveBrain(
    [connector({ providerId: "local", kind: "local-serve", enabledFor: ["prometheus"] })],
    "embeddings",
  );
  assert.equal(r, null);
});

// ---- §3.2 key-shadows-oauth footgun --------------------------------------- //

test("detectKeyShadowsOauth fires when a subscription provider is wired by raw key", () => {
  const warn = detectKeyShadowsOauth(
    connector({
      providerId: "claude",
      kind: "api-key",
      modelId: "claude-sonnet-4-6",
      confirmedCostWarningAt: "2026-06-01",
    }),
    PROVIDERS,
  );
  assert.ok(warn);
  assert.match(warn ?? "", /subscription/i);
});

test("detectKeyShadowsOauth is silent for local + for genuinely key-only providers", () => {
  assert.equal(
    detectKeyShadowsOauth(connector({ providerId: "local", kind: "local-serve" }), PROVIDERS),
    null,
  );
  assert.equal(
    detectKeyShadowsOauth(
      connector({
        providerId: "open-weight-api-host",
        kind: "api-key",
        modelId: "deepseek-chat",
        confirmedCostWarningAt: "2026-06-01",
      }),
      PROVIDERS,
    ),
    null,
  );
});

// ---- validateConnector policy gate ---------------------------------------- //

test("validateConnector flags a Tier-C connector with no guardrail and no confirmation", () => {
  const c = connector({
    providerId: "open-weight-api-host",
    kind: "api-key",
    modelId: "deepseek-chat",
    keyRef: { service: "com.prometheus.studio", account: "open-weight-api-host" },
  });
  const codes = validateConnector(c, PROVIDERS).map((i) => i.code);
  assert.ok(codes.includes("missing-guardrail"));
  assert.ok(codes.includes("unconfirmed-metered"));
});

test("validateConnector passes a fully-wired Tier-A local connector", () => {
  const c = connector({
    providerId: "local",
    kind: "local-serve",
    modelId: "qwen3:8b",
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  assert.deepEqual(validateConnector(c, PROVIDERS), []);
});

test("validateConnector rejects an unknown provider and an unsupported kind", () => {
  const unknown = validateConnector(
    {
      providerId: "nope",
      kind: "api-key",
      modelId: "x",
      effectiveTier: "C",
      enabledFor: ["agent-pane"],
    },
    PROVIDERS,
  );
  assert.equal(unknown[0]?.code, "unknown-provider");
  const badKind = validateConnector(
    connector({
      providerId: "cursor",
      kind: "api-key",
      modelId: "x",
      keyRef: { service: "s", account: "a" },
      guardrail: {
        monthlyCapUsd: 10,
        warnAtPct: 0.8,
        spentThisMonthUsd: 0,
        onCap: "auto-disable",
        resetsOn: "2026-07-01",
      },
      confirmedCostWarningAt: "2026-06-01",
    }),
    PROVIDERS,
  );
  assert.ok(badKind.some((i) => i.code === "kind-unsupported"));
});

// ── CLI-058: model-aware pricing ────────────────────────────────────────────────
const PRICING: Pricing = {
  claude: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "claude-sonnet-4": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "claude-opus-4": { inputUsdPerMTok: 15, outputUsdPerMTok: 75 },
  "gpt-4o": { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 },
};

test("priceForModel: longest-prefix, case-insensitive; absent → null (CLI-058)", () => {
  // versioned id resolves the LONGEST matching prefix, not the shorter `claude`.
  assert.equal(priceForModel(PRICING, "claude-opus-4-20250219")?.outputUsdPerMTok, 75);
  assert.equal(priceForModel(PRICING, "Claude-Sonnet-4-6")?.inputUsdPerMTok, 3); // case-insensitive
  assert.equal(priceForModel(PRICING, "claude-3-haiku")?.inputUsdPerMTok, 3); // falls back to `claude`
  assert.equal(priceForModel(PRICING, "mystery-model"), null); // absent → null (never a guess)
});

test("contextLenForModel: same longest-prefix rule as pricing; absent → null (CLI-092)", () => {
  const withCtx: Pricing = {
    claude: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, contextLen: 100_000 },
    "claude-opus-4": { inputUsdPerMTok: 15, outputUsdPerMTok: 75, contextLen: 200_000 },
    "gpt-4o": { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 }, // no contextLen on this entry
  };
  assert.equal(contextLenForModel(withCtx, "claude-opus-4-20250219"), 200_000);
  assert.equal(contextLenForModel(withCtx, "claude-3-haiku"), 100_000); // falls back to `claude`
  assert.equal(contextLenForModel(withCtx, "gpt-4o-mini"), null); // priced but no contextLen
  assert.equal(contextLenForModel(withCtx, "mystery-model"), null); // absent → null
});

test("loadPricing: the shipped config carries a real contextLen for known cloud models (CLI-092)", () => {
  const p = loadPricing();
  assert.equal(contextLenForModel(p, "claude-sonnet-4-6-20250219"), 200_000);
  assert.equal(contextLenForModel(p, "gpt-4o-2026-01-01"), 128_000);
});

test("costOf: exact tokens×rate; local → 0; unknown → null (CLI-058)", () => {
  // round-number rate ($3/M in, $15/M out) → exact equality (no float drift).
  const cost = costOf(
    { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    "claude-sonnet-4",
    PRICING,
    false,
  );
  assert.equal(cost, 18); // 1M×$3 + 1M×$15
  assert.equal(
    costOf({ inputTokens: 5000, outputTokens: 5000 }, "claude-sonnet-4", PRICING, true),
    0,
  ); // local
  assert.equal(
    costOf({ inputTokens: 5000, outputTokens: 5000 }, "who-knows", PRICING, false),
    null,
  ); // unknown
});

test("loadPricing: reads the shipped config + drops non-numeric entries (CLI-058)", () => {
  const p = loadPricing(); // the bundled providers.config.json
  assert.ok(Object.keys(p).length > 0, "pricing map is populated");
  for (const entry of Object.values(p)) {
    assert.equal(typeof entry.inputUsdPerMTok, "number");
    assert.equal(typeof entry.outputUsdPerMTok, "number");
  }
  // a claude id resolves to a real rate.
  assert.ok(priceForModel(p, "claude-sonnet-4-6") !== null);
});
