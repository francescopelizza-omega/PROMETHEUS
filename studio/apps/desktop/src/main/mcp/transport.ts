// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/mcp/transport.ts — the desktop's MCP client transports (re-export shim).
 *
 * Both real transports now live in core (Node-only `@prometheus/core/mcp-node` subpath) so the
 * CLI and the desktop share ONE audited implementation: the stdio JSON-RPC child transport
 * (CLI-036) and the streamable-HTTP client (CLI-037, lifted here from the former APP-095 local
 * class). This module's public surface — `StdioMcpTransport`, `createStdioTransportFactory`,
 * and the combined kind-dispatching `createMcpTransportFactory` — is unchanged; it now simply
 * forwards to core. The desktop keeps global `fetch` + no keychain auth resolver (its historical
 * behaviour); the SSRF/redirect gate and typed errors are enforced inside the core transport.
 *
 * Node/Electron main only (stdio spawns a child) — never importable into the renderer (C5).
 */
export {
  StdioMcpTransport,
  StreamableHttpTransport,
  createStdioTransportFactory,
  createHttpTransportFactory,
  createMcpTransportFactory,
} from "@prometheus/core/mcp-node";
