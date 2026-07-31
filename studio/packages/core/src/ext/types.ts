/**
 * ext/types.ts — the extension manifest + context model (file 09 §5.1/§5.2).
 *
 * `prometheus.extension.json` is a superset of VS Code's `contributes` model plus
 * our two security-first additions: `agents` (drop-in AgentDefs) and `permissions`
 * (DECLARED, enforced, surfaced at install). The shipped schema discriminator is
 * `extension@1` (schemas/extension/v1.json) — this type mirrors it.
 */
import type { McpTransport } from "../mcp/host/types.js";

/** Network policy: no egress, only declared MCP servers, or a host allowlist. */
export type ExtNetworkPolicy = "none" | "mcp-only" | string[];

/** Declared permissions — enforced at the ExtensionContext boundary (§5.2). */
export interface ExtPermissions {
  fs?: { read?: string[]; write?: string[] };
  network?: ExtNetworkPolicy;
  /** prometheus subcommands the extension may invoke (read-only by default). */
  engine?: string[];
  /** keychain entries it may request (user-approved). */
  secrets?: string[];
  shell?: boolean;
}

export interface ExtPanel {
  id: string;
  title: string;
  location: "primary-sidebar" | "secondary-sidebar" | "panel";
  entry: string; // sandboxed webview entry
}

export interface ExtCommand {
  id: string;
  title: string;
  category?: string;
}

export interface ExtKeybinding {
  command: string;
  key: string;
}

export interface ExtThemeContribution {
  id: string;
  label: string;
  base: "dark" | "light" | "high-contrast";
  path: string;
}

export interface ExtAgentContribution {
  path: string; // points at an AgentDef JSON (§4)
}

export interface ExtMcpServerContribution {
  id: string;
  transport: McpTransport; // gated like any host server (§2.2)
}

export interface ExtConfigEntry {
  type: "number" | "string" | "boolean";
  default?: number | string | boolean;
  description?: string;
}

export interface ExtContributes {
  commands?: ExtCommand[];
  keybindings?: ExtKeybinding[];
  themes?: ExtThemeContribution[];
  agents?: ExtAgentContribution[];
  mcpServers?: ExtMcpServerContribution[];
  configuration?: Record<string, ExtConfigEntry>;
}

/** The extension@1 manifest (mirrors schemas/extension/v1.json). */
export interface ExtensionManifest {
  schema: "extension@1";
  id: string; // <publisher>.<name>, globally unique
  label: string; // human-readable display name
  version: string; // semver
  publisher?: string;
  description?: string;
  engines?: { studio?: string };
  main?: string; // activation entrypoint (ext host, not renderer)
  ui?: { panels?: ExtPanel[] };
  contributes?: ExtContributes;
  permissions?: ExtPermissions;
  repo?: string; // source of truth for the marketplace nemesis gate
  license?: string;
}
