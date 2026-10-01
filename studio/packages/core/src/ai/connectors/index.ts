// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/connectors — the 4 connector kinds as pure builders + injected runtime seams
 * (file 12 §1.2). local-serve (Tier A), oauth-subscription-bridge (Tier B),
 * cli-passthrough (Tier B, nemesis-gated + never --force), api-key (Tier C, guarded).
 * Secrets are read lazily from the keychain — never embedded in a descriptor.
 */
export {
  ConnectorError,
  type AiEndpoint,
  type CliLaunchSpec,
  type ConnectorEndpoint,
  type GateFn,
  type GateVerdict,
  type KeyResolver,
  type SpawnLike,
} from "./types.js";
export {
  DEFAULT_LOCAL_BASEURL,
  type LocalServeOpts,
  buildLocalServeConnector,
} from "./localServe.js";
export { buildApiKeyConnector } from "./apiKey.js";
export { buildOauthConnector } from "./oauthBridge.js";
export {
  FORBIDDEN_CLI_FLAGS,
  type CliLaunchDeps,
  type CliLaunchOpts,
  type CliLaunchResult,
  buildCliLaunchSpec,
  launchCliPassthrough,
} from "./cliPassthrough.js";
