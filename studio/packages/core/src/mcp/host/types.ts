// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
  /**
   * Hash of the tool descriptor set as of the last clean `connect()` — the gate only re-scans
   * the launch command, never what the server LATER claims its tools do, so this is what
   * `connect()` compares a fresh `tools/list` against to catch a "rug pull" (a server silently
   * redefining a description or an annotation after the user already approved it). Undefined
   * until the first successful connect after an add/re-add establishes it.
   */
  toolsPinnedHash?: string;
  /**
   * WHY `health` is `"blocked"` — `"gate"` (the add-time nemesis verdict on the launch command)
   * or `"tool-drift"` (a later `connect()` caught the pinned tool descriptors changing). Without
   * this, both causes threw the identical "blocked by nemesis" message, which sent an operator
   * debugging a rug-pull block looking at the wrong thing (the launch command, which never
   * changed) instead of the tool descriptors, which did. Cleared on every (re-)add alongside
   * `toolsPinnedHash`, same as it.
   */
  blockedReason?: "gate" | "tool-drift";
}
