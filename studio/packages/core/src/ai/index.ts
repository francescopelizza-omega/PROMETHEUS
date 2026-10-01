// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
export {
  type TurnOutcomeContext,
  type TurnStopReason,
  emptyTurnNotice,
  estimateRequestTokens,
  truncationNotice,
} from "./turn-outcome.js";

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
  MIN_REPLY_RESERVE_TOKENS,
  REPLY_RESERVE_FRACTION,
  preflightContext,
  replyReserveFor,
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
export type { LocalRunnerSpec } from "./local-runners.js";
export {
  LOCAL_RUNNERS,
  localRunners,
  applyHostEnv,
  runnerForBaseUrl,
  runnerById,
  portOf,
  isLocalUrl,
} from "./local-runners.js";

// The machine scan. Both surfaces used to answer "which runners do you have?" from a literal
// table; this answers it by asking the machine. See runner-discovery.ts's docstring.
export type { DiscoveredRunner, DiscoverDeps, RunnerState } from "./runner-discovery.js";
export {
  DEFAULT_PROBE_TIMEOUT_MS,
  describeProbeFailure,
  discoverRunners,
  modelsFromOpenAiList,
  modelsFromTags,
  nextStepHint,
  servedModelOptions,
} from "./runner-discovery.js";

export type { EnsureOllamaOptions, EnsureOllamaResult } from "./ollama-autostart.js";
export { ensureLmStudioRunning, ensureOllamaRunning } from "./ollama-autostart.js";

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

// --- the served context window, MEASURED (exported to the ai barrel 2026-09-25) ------------
// The VS Code extension was the last surface still ASSERTING a window (a hardcoded 8192, which
// is the number CLAUDE.md §2.8 records as the cause of empty turns). It could not probe because
// the probe was never on this barrel — only `DEFAULT_CONTEXT_WINDOW` reached the root index.
export type { ContextWindowResult, ContextWindowSource } from "./context-window.js";
export {
  CONTEXT_PROBE_AWAIT_MS,
  DEFAULT_CONTEXT_WINDOW,
  PROBE_TIMEOUT_MS,
  probeContextWindow,
} from "./context-window.js";

// --- memory admission (2026-09-25) -----------------------------------------
// Whether a model fits, computed from geometry verified against ollama's own allocation, and
// the two rules that follow from it: one model server at a time, and nothing starts that does
// not fit. Host-parameterised throughout, so a remote model is judged by the REMOTE host's RAM.
export type {
  Admission,
  KvCacheType,
  KvGeometry,
  MemoryBudget,
  ModelFootprint,
} from "./model-footprint.js";
export {
  FALLBACK_KV_BYTES_PER_TOKEN,
  FLOOR_KV_BYTES_PER_TOKEN,
  MIN_RUNNER_OVERHEAD_BYTES,
  RUNNER_OVERHEAD_BYTES,
  admitModel,
  bytesPerElement,
  estimatedLowerBound,
  expandWindowPattern,
  humanBytes,
  kvBytesForContext,
  modelFootprint,
  parseKvGeometry,
  servedContext,
} from "./model-footprint.js";

// --- learning what a model really costs (2026-09-25) ------------------------
// Architecture arithmetic prices the KV cache exactly; the weights and the runner overhead it
// can only allow for. One real observation solves the overhead term outright, so a model that
// has loaded once is never estimated again — which is what stops a cautious allowance from
// refusing a model that would have run.
export type { FootprintObservation } from "./footprint-ledger.js";
export {
  MAX_OBSERVATIONS,
  MAX_OBSERVATIONS_PER_MODEL,
  OBSERVATION_TTL_MS,
  calibratedOverhead,
  kvSlope,
  ledgerFootprint,
  measuredKvPerToken,
  ledgerKey,
  observationsFor,
  parseObservations,
  recordObservation,
  solveOverhead,
} from "./footprint-ledger.js";
export type { OllamaLoadRecord } from "./ollama-log-parse.js";
export {
  latestPerModel,
  modelNameFrom,
  nearestModel,
  normalizeModelName,
  parseOllamaLog,
  parseSizeToBytes,
} from "./ollama-log-parse.js";
export type {
  AdmissionDecision,
  AdmissionRequest,
  AffordableModel,
  ModelCandidate,
  ResidentServer,
} from "./model-admission.js";
export {
  admitModelLoad,
  affordableModels,
  footprintNote,
  footprintOf,
  reclaimableBytes,
  renderRefusal,
} from "./model-admission.js";
export type { InstalledModel } from "./ollama-inventory.js";
export {
  fetchModelGeometry,
  inventoryCandidates,
  listInstalledModels,
  ollamaRoot,
} from "./ollama-inventory.js";

// --- self-hosted remote model servers (2026-09-25) --------------------------
// A GPU box you own is not a cloud provider. DEFAULT DENY: a host is trusted only once
// declared by hand; nothing is inferred from a private IP range.
export type { RemoteHost } from "./remote-hosts.js";
export {
  REMOTE_HOSTS_KEY,
  parseRemoteHostsSetting,
  findRemoteHost,
  hostOf,
  isDeclaredRemoteHost,
  isPrivateAddress,
  localityWithRemotes,
  normalizeHost,
  warnings as remoteHostWarnings,
} from "./remote-hosts.js";

// --- real remote machines, over SSH (2026-09-25) ----------------------------
// The SSH argv builder and the hardware probe live in `@prometheus/engine-bridge`, not here:
// core DEPENDS ON engine-bridge (never the reverse), and a module whose whole purpose is to
// construct a child-process argv safely belongs beside the code that spawns it (C5 / SPINE).
// The types are re-exported here so a caller reasoning about remote hosts has one import.
export type { RemoteGpu, RemoteHardware, SshTarget } from "@prometheus/engine-bridge";
