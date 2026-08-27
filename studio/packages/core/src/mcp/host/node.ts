/**
 * mcp/host/node.ts — the Node-only MCP transport barrel (`@prometheus/core/mcp-node`).
 *
 * The CLI and the desktop main both import their MCP transports from here so they share ONE
 * audited implementation: the stdio child-process transport (CLI-036) and the streamable-HTTP
 * transport (CLI-037). This file is the ONLY place the two are combined into a single
 * kind-dispatching `TransportFactory` — it pulls the Node-only stdio child, so it is never
 * importable into the renderer barrel (`mcp/host/index.ts`), which stays pure.
 */
import {
  type FetchLike,
  type HttpTransportDeps,
  StreamableHttpTransport,
  createHttpTransportFactory,
} from "./http-transport.js";
import { appendMcpAudit, mcpAuditPath } from "./mcp-audit.js";
import {
  StdioMcpTransport,
  type StdioSpawn,
  type StdioTransportDeps,
  createStdioTransportFactory,
} from "./stdio-transport.js";
import type { McpClientTransport, TransportFactory } from "./transports.js";
import type { McpServerConfig } from "./types.js";

export {
  StdioMcpTransport,
  createStdioTransportFactory,
  StreamableHttpTransport,
  createHttpTransportFactory,
  appendMcpAudit,
  mcpAuditPath,
};
export type { FetchLike, HttpTransportDeps, StdioSpawn, StdioTransportDeps };
// Opt-in real-server e2e harness (CLI-038) — dev/test tooling, spawns a pinned reference server.
export {
  REFERENCE_SERVER_VERSION,
  REFERENCE_SERVER_PKG,
  referenceServerConfig,
  referenceServerPids,
  prewarmReferenceServer,
  createReferenceHarness,
} from "./e2e-harness.js";
export type { ReferenceHarness } from "./e2e-harness.js";

/**
 * The combined TransportFactory: dispatches by `transport.kind` — the stdio child transport
 * or the streamable-HTTP client. `deps` (an injected fetch + a keychain auth resolver) flow
 * only to the http transport; stdio takes none. Called with no args it defaults to
 * `globalThis.fetch` and no auth resolver (the desktop's historical behaviour).
 */
export function createMcpTransportFactory(deps: HttpTransportDeps = {}): TransportFactory {
  return (cfg: McpServerConfig): McpClientTransport =>
    cfg.transport.kind === "http"
      ? new StreamableHttpTransport(cfg, deps)
      : new StdioMcpTransport(cfg);
}
