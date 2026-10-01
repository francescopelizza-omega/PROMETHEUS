// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agents/index.ts — the agent runtime barrel (file 09 §4).
 *
 * The agent definition model (§4.1), the §4.4 sandbox guards (path/ref/narrowing),
 * the §4.3 ToolBroker, the ReAct orchestrator (§4.2), and the registry + dispatcher
 * routing + spawn supervisor. All pure; the model client + tool handlers are injected.
 */
export type {
  ModelRef,
  AgentToolGrant,
  AgentSandbox,
  AgentMemory,
  AgentSchedule,
  AgentSource,
  AgentDef,
} from "./types.js";
export { DEFAULT_SANDBOX } from "./types.js";
export type { ToolRefKind, ParsedToolRef } from "./sandbox.js";
export {
  parseToolRef,
  normalizePath,
  expandWorkspace,
  globToRegExp,
  globMatch,
  isPathAllowed,
  sandboxWithin,
  narrowSandbox,
} from "./sandbox.js";
export type { BrokerInput, BrokerDecision } from "./toolBroker.js";
export { brokerDecision, grantFor } from "./toolBroker.js";
