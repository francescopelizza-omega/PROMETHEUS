/**
 * main/mcp/gate.ts — the real nemesis gate for MCP connectors (file 09 §2.2).
 *
 * Core's `McpHostManager` gates every server's launch command / source repo before it
 * is ever spawned, through an injected `NemesisGate`. Core stays engine-free; the
 * desktop provides THIS real runner, which wraps the ONLY sanctioned nemesis spawner —
 * engine-bridge `gate()` (C4/C5, same one the IDE run-gate uses). A scan that can't
 * run is FAIL-CLOSED to "error" (→ the server is marked blocked, not spawned).
 */
import type { mcpHost } from "@prometheus/core";
import { type EngineConfig, type VerdictTier, gate as engineGate } from "@prometheus/engine-bridge";

/** Build the injected MCP gate over the real engine-bridge nemesis runner. */
export function createMcpGate(config: EngineConfig = {}): mcpHost.NemesisGate {
  return async (target: string): Promise<mcpHost.HostGateVerdict> => {
    try {
      const v = await engineGate(target, {}, config);
      return {
        verdict: v.verdict,
        riskScore: v.risk_score,
        target,
        findings: v.findings.length,
      };
    } catch {
      // the scan itself failed — treat as "error" (blocks the connector), never as allow.
      return { verdict: "error" as VerdictTier, target, findings: 0 };
    }
  };
}
