/**
 * orchestration/index.ts — the `/demos` multi-CLI agent-swarm barrel.
 *
 * A pure orchestration engine: a TOPOLOGY of heterogeneous agents (each bound to one
 * backend — a vendor CLI / local model / in-process agent), a MESSAGE BUS they all talk
 * through (peer↔peer + child→parent), an in-band DIRECTIVE protocol, runaway GUARDS, and
 * the recursive COORDINATOR that drives them. Backends are injected (the only IO), so the
 * whole engine is unit-testable + reusable by the CLI and the GUI.
 */
export type {
  BackendKind,
  BackendRef,
  AgentSpec,
  AgentOp,
  RunLimits,
  OrchestrationTopology,
  ValidationResult,
} from "./topology.js";
export {
  ALL_OPS,
  DEFAULT_LIMITS,
  getAgent,
  childrenOf,
  peersOf,
  parentOf,
  ancestryOf,
  depthOf,
  validateTopology,
  normalizeTopology,
} from "./topology.js";

export type { MessageKind, Message, PostInput, BusDeps } from "./bus.js";
export { MessageBus, parseBusJsonl } from "./bus.js";

export type { Directive, ParsedOutput } from "./protocol.js";
export { parseDirectives, parseBackendRef } from "./protocol.js";

// --- paid OpenAI-compatible API providers as own-key subagents (api backend kind) ----- //
export type { ApiProvider, ApiAutomation } from "./api-providers.js";
export {
  API_PROVIDERS,
  API_PROVIDER_IDS,
  apiProviderFor,
  isApiProvider,
  apiBackendFor,
  resolveApiKey,
} from "./api-providers.js";

export type { GuardVerdict } from "./guards.js";
export { RunBudget, checkDepth, checkFanout, checkCycle } from "./guards.js";

export type {
  InvokeRequest,
  InvokeResult,
  BackendInvoker,
  RunEvent,
  CoordinatorDeps,
  RunResult,
} from "./coordinator.js";
export { Coordinator, runOrchestration, buildPrompt } from "./coordinator.js";

// --- the tmux-relay scheduler (external comms between interactive AI-CLI windows) ----- //
export type {
  PaneState,
  AgentObservation,
  RelayTmux,
  RelayClock,
  RelayConfig,
} from "./relay-seams.js";
export { DEFAULT_RELAY_CONFIG } from "./relay-seams.js";
export type {
  RelayReason,
  RelayEvent,
  RelaySchedulerDeps,
  RelayResult,
} from "./relay-scheduler.js";
export { runRelay } from "./relay-scheduler.js";
