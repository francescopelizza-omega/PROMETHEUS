/**
 * mcp/index.ts — the MCP public-surface barrel (file 09 §2, APP-095).
 *
 * One import site for both halves of Studio's MCP support: the HOST (Studio as a client
 * of external servers — manager, gate, policy, importers, transport seam + the pure
 * remote-transport validation) and the SERVER (Studio exposing its own tools). Core stays
 * SDK-free + transport-injected; the real stdio/HTTP clients live in the desktop main
 * process (main/mcp/*) and are injected via `TransportFactory` (never a `fetch`/`net`
 * import inside packages/core — the injected-seam invariant, transports.ts header).
 */
export * as host from "./host/index.js";
export * as server from "./server/index.js";

// The remote-transport SSRF/header validation is the one piece the DESKTOP main process
// must call on every renderer-supplied URL BEFORE any network I/O, so surface it directly.
export {
  isPrivateHost,
  validateRemoteTransport,
  type RemoteTransportValidation,
} from "./host/transports.js";
