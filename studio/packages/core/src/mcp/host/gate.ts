/**
 * mcp/host/gate.ts — the §2.2 security gate on every external MCP server.
 *
 * Before a stdio server is ever spawned, its launch `command` (or, for a
 * marketplace server, its source repo) is run through nemesis EXACTLY like a plugin
 * install — we route through the engine, never reimplement security (file 09 §0).
 * The actual nemesis call is an INJECTED runner (`NemesisGate`) so core stays free
 * of the engine-bridge runtime here and tests use a fake; the real runner wraps
 * `@prometheus/engine-bridge` runNemesis(["gate", target]).
 *
 * A high/critical (block) or scan-failed (error) verdict ⇒ health="blocked": the
 * server is NOT spawned. The GUI then shows the file-03 verdict card with a force
 * affordance (typed-confirm). Same defense-in-depth posture as the engine.
 */
import type { HostGateVerdict, McpServerConfig, McpTransport } from "./types.js";

/** A nemesis gate runner: a target (path/repo/url) → its verdict. */
export type NemesisGate = (target: string) => Promise<HostGateVerdict>;

/**
 * Resolve what to gate for a transport. For stdio we audit the launch command
 * (a resolved binary/script path); for http we audit the URL. The command may be
 * a bare name (resolved against PATH by the spawner) or an absolute/relative path —
 * we return it verbatim for the engine's nemesis runner to resolve + scan.
 */
export function resolveCommandPath(transport: McpTransport): string {
  return transport.kind === "stdio" ? transport.command : transport.url;
}

/** The exact target nemesis scans for a server (marketplace repo wins over command). */
export function gateTarget(cfg: McpServerConfig): string {
  if (cfg.source === "marketplace" && cfg.repo) return cfg.repo;
  return resolveCommandPath(cfg.transport);
}

/** Run the §2.2 gate for a server config via the injected nemesis runner. */
export function gateServer(cfg: McpServerConfig, runGate: NemesisGate): Promise<HostGateVerdict> {
  return runGate(gateTarget(cfg));
}

/** Whether a verdict forbids spawning the server (block/error ⇒ health="blocked"). */
export function verdictBlocks(v: HostGateVerdict | undefined): boolean {
  return v?.verdict === "block" || v?.verdict === "error";
}
