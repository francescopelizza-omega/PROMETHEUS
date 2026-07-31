/**
 * mcp/host/types.ts — the MCP HOST data model (file 09 §2.1, verbatim).
 *
 * Studio is an MCP *client* of many external servers (filesystem, github, your own,
 * and — via the §2.4 boot path — the embedded Prometheus engine itself). This is the
 * pure data model; the live SDK Client lives behind the injected `McpClientTransport`
 * (transports.ts), so core never imports @modelcontextprotocol/sdk.
 */
import type { VerdictTier } from "@prometheus/engine-bridge";
import type { ToolAnnotations } from "../server/tools.js";

/** How Studio reaches a server: a spawned stdio subprocess, or a streamable-http URL. */
export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | {
      kind: "http";
      url: string;
      headers?: Record<string, string>;
      /** Name of a keychain secret (NOT the value) → `Authorization: Bearer <v>` at connect (CLI-037). */
      authSecretRef?: string;
      /** Per-request timeout override in ms (default 15_000); an abort rejects, never hangs. */
      timeoutMs?: number;
    };

/** A tool a server exposes (from tools/list). */
export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema as returned by tools/list. */
  inputSchema: unknown;
  annotations?: ToolAnnotations;
}

export type McpServerHealth = "unknown" | "starting" | "ready" | "error" | "blocked";
export type McpServerScope = "global" | "profile" | "workspace";
export type McpServerSource = "builtin" | "marketplace" | "imported" | "manual";

/** The last nemesis verdict on a server's launch command / source (the §2.2 gate). */
export interface HostGateVerdict {
  verdict: VerdictTier; // allow | warn | block | error
  riskScore?: number;
  target: string; // what was gated (resolved command path or source repo)
  findings?: number;
}

/** A configured MCP server (§2.1). */
export interface McpServerConfig {
  id: string; // stable slug, e.g. "github", "filesystem", "prometheus"
  label: string;
  transport: McpTransport;
  enabled: boolean; // user toggle (reversible)
  scope: McpServerScope; // where the config lives (§6)
  autoApprove: string[]; // tool names the user pre-approved (default [])
  source: McpServerSource;
  repo?: string; // marketplace source repo (gated instead of the command)
  gate?: HostGateVerdict; // last nemesis verdict (§2.2/§3)
  capabilities?: { tools: McpToolDescriptor[]; resources: boolean; prompts: boolean };
  health: McpServerHealth;
}
