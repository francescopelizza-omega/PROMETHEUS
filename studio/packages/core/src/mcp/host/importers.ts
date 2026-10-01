// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * mcp/host/importers.ts — read existing MCP configs + the §2.4 boot config (file 09 §2.3/§2.4).
 *
 * Power users already have MCP servers wired into Claude/Cursor/Codex/etc. We READ
 * those configs (never write them on import) and offer "Import N servers" with a
 * per-server nemesis gate before enabling any in Studio. These are PURE parsers over
 * file CONTENTS (the actual fs read is the host's job); every parser is graceful — a
 * malformed file or entry is skipped, never thrown (matches the engine reader + the
 * merge-safe writers' fail-open-ish philosophy).
 *
 * Config paths the host reads (§2.3): ~/.claude.json, ~/.cursor/mcp.json,
 * ~/.codex/config.toml, ~/.codeium/windsurf/mcp_config.json, ~/.config/zed/settings.json,
 * ~/.continue/config.yaml, and the Cline VS Code globalStorage cline_mcp_settings.json.
 */
import type { McpServerConfig, McpServerScope, McpServerSource, McpTransport } from "./types.js";

/** The §2.3 config files, by agent id (host resolves ~ and reads each, then parses). */
export const MCP_CONFIG_PATHS: Record<string, string> = {
  claude: "~/.claude.json",
  cursor: "~/.cursor/mcp.json",
  codex: "~/.codex/config.toml",
  windsurf: "~/.codeium/windsurf/mcp_config.json",
  zed: "~/.config/zed/settings.json",
  continue: "~/.continue/config.yaml",
  cline:
    "~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
};

export interface BuiltinPrometheusOpts {
  node: string; // process.execPath
  serverJs: string; // <studioRoot>/resources/mcp/dist/server.js
  prometheusPy: string; // bundled or detected prometheus.py
  scope?: McpServerScope;
}

/**
 * The §2.4 boot config: Studio auto-registers its OWN embedded server as a host
 * connection (written to Studio config, NOT to ~/.claude.json). Read-only tools are
 * auto-approved; the destructive install/uninstall/enable/disable are never listed.
 */
export function builtinPrometheusConfig(o: BuiltinPrometheusOpts): McpServerConfig {
  return {
    id: "prometheus",
    label: "Prometheus Engine",
    transport: {
      kind: "stdio",
      command: o.node,
      args: [o.serverJs],
      env: { PROMETHEUS_PY: o.prometheusPy },
    },
    enabled: true,
    scope: o.scope ?? "global",
    autoApprove: [
      "prometheus_scan",
      "prometheus_list",
      "prometheus_info",
      "prometheus_where",
      "prometheus_status",
      "prometheus_matrix",
      "prometheus_skills_list",
      "prometheus_vault_status",
    ],
    source: "builtin",
    health: "unknown",
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build a transport from a raw server entry; null if neither stdio nor http is valid. */
function transportFromEntry(entry: Record<string, unknown>): McpTransport | null {
  if (typeof entry.command === "string" && entry.command.length > 0) {
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : [];
    const env = isRecord(entry.env)
      ? (Object.fromEntries(
          Object.entries(entry.env).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>)
      : undefined;
    return { kind: "stdio", command: entry.command, args, ...(env ? { env } : {}) };
  }
  if (typeof entry.url === "string" && entry.url.length > 0) {
    return { kind: "http", url: entry.url };
  }
  return null;
}

/** Map a `{ id: entry }` server map → McpServerConfig[] (imported, disabled until gated). */
function mapServerObject(
  servers: Record<string, unknown>,
  source: McpServerSource,
): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  for (const [id, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) continue;
    const transport = transportFromEntry(raw);
    if (!transport) continue;
    out.push({
      id,
      label: typeof raw.label === "string" ? raw.label : id,
      transport,
      enabled: false, // imported servers stay OFF until the per-server gate + user enable
      scope: "global",
      autoApprove: [],
      source,
      health: "unknown",
    });
  }
  return out;
}

/**
 * Parse a JSON config carrying `mcpServers` (Claude/Cursor/Windsurf/Cline) OR
 * `context_servers` (Zed). Graceful: bad JSON → []; bad entries skipped.
 */
export function parseMcpServersJson(
  text: string,
  source: McpServerSource = "imported",
): McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const servers = isRecord(parsed.mcpServers)
    ? parsed.mcpServers
    : isRecord(parsed.context_servers)
      ? parsed.context_servers
      : null;
  if (!servers) return [];
  return mapServerObject(servers, source);
}

/**
 * Best-effort parser for the Codex `config.toml` `[mcp_servers.<id>]` tables.
 * Minimal (no full TOML): reads `command = "..."` and `args = [...]` per section;
 * anything it cannot parse is skipped. Graceful by construction.
 */
export function parseCodexToml(
  text: string,
  source: McpServerSource = "imported",
): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  const sectionRe = /^\[mcp_servers\.([A-Za-z0-9._-]+)\]\s*$/;
  const lines = text.split(/\r?\n/);
  let current: { id: string; command?: string; args: string[] } | null = null;
  const flush = (): void => {
    if (current?.command) {
      out.push({
        id: current.id,
        label: current.id,
        transport: { kind: "stdio", command: current.command, args: current.args },
        enabled: false,
        scope: "global",
        autoApprove: [],
        source,
        health: "unknown",
      });
    }
    current = null;
  };
  for (const line of lines) {
    const m = sectionRe.exec(line.trim());
    if (m) {
      flush();
      current = { id: m[1] as string, args: [] };
      continue;
    }
    if (!current) continue;
    const cmd = /^command\s*=\s*"([^"]*)"/.exec(line.trim());
    if (cmd) current.command = cmd[1];
    const args = /^args\s*=\s*\[(.*)\]/.exec(line.trim());
    if (args) {
      current.args = (args[1] as string)
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter((s) => s.length > 0);
    }
  }
  flush();
  return out;
}
