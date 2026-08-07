/**
 * ai — the billing-aware AI-integration layer (file 12).
 *
 * The durable spine is a 3-tier promotion hierarchy: A local/free (the default), B
 * subscription-included (bounded), C metered (allowed, never promoted, always warned).
 * Four sub-modules:
 *  - `providers` — the data-driven matrix + the tier/light/warn policy + brain resolver;
 *  - `connectors` — the 4 connector kinds as pure builders + injected runtime seams
 *    (secrets stay in the keychain; cli-passthrough is nemesis-gated + never --force);
 *  - `guardrails` — the metered-spend control subsystem (estimate → enforce → meter);
 *  - `repoint` — the localai "run it free locally" escape hatch.
 *
 * Re-exported from `@prometheus/core` as the `ai` NAMESPACE (its `CostLight`,
 * `BillingMode`, `ConnectorConfig` are richer than — and must not collide with — the
 * C11 `domain/models.ts` flat exports). The thin HTTP client stays at `core` top-level
 * (`createAiClient`); this layer is config + policy + wiring, not the wire protocol.
 */
export * from "./providers/index.js";
export * from "./connectors/index.js";
export * from "./guardrails/index.js";
export * from "./repoint/index.js";
export * from "./effort/index.js";
