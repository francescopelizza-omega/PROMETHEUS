/**
 * main/mcp/gate.ts — the real nemesis gate for MCP connectors (file 09 §2.2).
 *
 * Core's `McpHostManager` gates every server before it is spawned, through an injected
 * `NemesisGate`. Core stays engine-free; the desktop provides the real runner.
 *
 * The runner itself lives in engine-bridge (`createMcpGateRunner`) because there were THREE
 * copies of it — here and twice in the CLI — and all three fed the target to nemesis's FILE
 * scanner. A launch command is not a file: `gate("npx")` answers `error`/risk 100 and even a
 * resolved absolute binary answers `block`, both of which mean "do not spawn". Every MCP server
 * was therefore persisted `health:"blocked"` and no connector could be added on any host. See
 * that module for the measurements.
 */
import type { mcpHost } from "@prometheus/core";
import { type EngineConfig, createMcpGateRunner } from "@prometheus/engine-bridge";

/** Build the injected MCP gate over the real engine-bridge nemesis runner. */
export function createMcpGate(config: EngineConfig = {}): mcpHost.NemesisGate {
  return createMcpGateRunner(config) as mcpHost.NemesisGate;
}
