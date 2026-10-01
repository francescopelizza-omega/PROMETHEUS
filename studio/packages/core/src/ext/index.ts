// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ext/index.ts — the extension API barrel (file 09 §5).
 *
 * The extension@1 manifest type + fail-soft validator + semver gate (§5.1), the
 * default-deny permission enforcer (§5.2), the pure .promext install planner (§5.3),
 * the permission-bound ExtensionContext factory, and the host/webview SEAMS (the
 * Electron utility-process + sandboxed-webview boundaries are interface-only here).
 */
export type {
  ExtNetworkPolicy,
  ExtPermissions,
  ExtPanel,
  ExtCommand,
  ExtKeybinding,
  ExtThemeContribution,
  ExtAgentContribution,
  ExtMcpServerContribution,
  ExtConfigEntry,
  ExtContributes,
  ExtensionManifest,
} from "./types.js";
export { validateManifest, parseManifest, semverSatisfies, isCompatible } from "./manifest.js";
export type { ExtCapabilities } from "./permissions.js";
export { buildCapabilities, networkHostAllowed } from "./permissions.js";
export type {
  InstallPlan,
  InstallPlanError,
  InstallPlanResult,
  PlanInstallOptions,
} from "./loader.js";
export { permissionSummary, gateTargetFor, planInstall, isPlanError } from "./loader.js";
export type {
  Disposable,
  ExtCommandsApi,
  ExtUiApi,
  ExtWorkspaceApi,
  ExtEngineApi,
  ExtMcpApi,
  ExtSecretsApi,
  ExtensionContext,
  ExtensionBackends,
} from "./context.js";
export { createExtensionContext } from "./context.js";
export type { ActivationEvent, ActivateFn, ExtensionHost } from "./host.js";
export { activationEvents } from "./host.js";
export type { WebviewMessage, WebviewBridge } from "./webviewBridge.js";
export { isWebviewMessage } from "./webviewBridge.js";
