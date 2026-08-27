/**
 * The OS-keychain SERVICE name every host stores an MCP bearer token under.
 *
 * It was a local `const` duplicated per host, and the desktop simply never used it: the CLI
 * passed `resolveAuth` when building its transport factory and the desktop passed none, so a
 * connector added with `--auth-secret` worked in the terminal and 401'd in the app. A magic
 * string copied into each host is how the two ends of one keychain entry drift apart.
 */
export const MCP_AUTH_SERVICE = "prometheus-mcp-auth";

/**
 * mcp/host/index.ts — the MCP HOST barrel (file 09 §2).
 *
 * Studio as an MCP client of external servers: the data model, the §2.2 gate, the
 * §4.3 confirm policy, the SDK-agnostic transport seam, the importers (§2.3) + boot
 * config (§2.4), and the McpHostManager lifecycle. All pure; SDK/persistence/engine
 * are injected (the desktop main provides the real ones).
 */
export type {
  McpTransport,
  McpToolDescriptor,
  McpServerHealth,
  McpServerScope,
  McpServerSource,
  HostGateVerdict,
  McpServerConfig,
} from "./types.js";
export type { ConfirmPolicy } from "./policy.js";
export { confirmPolicy, autoApprovable } from "./policy.js";
export type { GateTargetKind, GateTargetSpec, NemesisGate } from "./gate.js";
export {
  resolveCommandPath,
  gateTarget,
  gateTargetSpec,
  gateServer,
  verdictBlocks,
} from "./gate.js";
export type {
  McpToolCallResult,
  McpClientTransport,
  TransportFactory,
  FakeTransportOptions,
  RemoteTransportValidation,
} from "./transports.js";
export {
  FakeTransport,
  McpTransportError,
  isPrivateHost,
  validateRemoteTransport,
} from "./transports.js";
export type { BuiltinPrometheusOpts } from "./importers.js";
export {
  MCP_CONFIG_PATHS,
  builtinPrometheusConfig,
  parseMcpServersJson,
  parseCodexToml,
} from "./importers.js";
export type { ConfigStore, McpHostDeps, CallToolOptions } from "./manager.js";
export { InMemoryConfigStore, McpHostManager } from "./manager.js";
