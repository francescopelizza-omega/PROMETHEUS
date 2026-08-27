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
export { mergeWireUsage, type WireUsage } from "./usage.js";

// Resilience for a model request: what a failure MEANS, and one retrying POST for all four
// transports. `resilience/retry.ts` had backoff, jitter and abort support with zero callers.
export type { PreflightResult } from "./retry-policy.js";
export {
  AI_RETRY_DEFAULTS,
  AiHttpError,
  ContextOverflowError,
  PREFLIGHT_MARGIN,
  advisedWaitTooLong,
  describeAiFailure,
  isAbort,
  isRetryableAiError,
  isRetryableStatus,
  parseRetryAfter,
  preflightContext,
  retryDelayMs,
} from "./retry-policy.js";
export type { ModelRequestInit, ModelRequestOptions, ModelResponseLike } from "./request.js";
export { endpointBreaker, fetchModelWithRetry } from "./request.js";

// Asking for the prompt cache this repo already measures.
export type { CacheableTextBlock, PromptCacheDialect, WireMsg } from "./prompt-cache.js";
export {
  PROMPT_CACHE_MIN_CHARS,
  applyPromptCache,
  cacheDialectFor,
  promptCachingSupported,
  shouldRequestPromptCache,
} from "./prompt-cache.js";

// Model health: the capability/breaker/context-window state this repo already measures,
// merged into one displayable, storable record. See that module's own header for why.
export type {
  ContextWindowOrigin,
  EndpointHealthRecord,
  ModelHealthStore,
  TransportMode,
} from "./model-health.js";
export {
  NO_BREAKER_SNAPSHOT,
  buildHealthRecord,
  describeBreaker,
  describeContextWindow,
  describeTransport,
  formatHealthTable,
  mergeHealthRecord,
  parseEndpointHealthRecord,
} from "./model-health.js";

// Turning a configured cloud provider into an endpoint an interactive session can select.
// The CLI's endpoint universe was two hardcoded LOCAL runners; the swarm lane knew all this
// and kept it to itself.
export type { CloudEndpointInfo, KeySource } from "./cloud-endpoints.js";
export {
  describeCloudEndpoint,
  discoverCloudEndpoints,
  endpointForProvider,
  envKeyRef,
  keychainKeyRef,
  parseKeyRef,
  providerForBaseUrl,
} from "./cloud-endpoints.js";

// The base-URL → runtime classifier. It already told anthropic/gemini/openai apart for the
// reasoning-effort field name; prompt caching and (later) the wire format need the same fact.
export { runtimeFromBaseUrl } from "./effort/rules.js";
export type { EffortRuntime } from "./effort/rules.js";

// The three wire formats. Every request in this repo spoke OpenAI chat/completions, which made
// Anthropic and Gemini unreachable — a request built for OpenAI 404s against api.anthropic.com.
export type {
  WireBodyOptions,
  WireEvent,
  WireFormat,
  WireMessage,
  WireTool,
  WireToolCall,
} from "./wire.js";
export {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_VERSION,
  ANTHROPIC_WIRE,
  GEMINI_WIRE,
  OPENAI_WIRE,
  selectWire,
} from "./wire.js";
