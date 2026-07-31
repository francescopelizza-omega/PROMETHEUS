/**
 * agents.ts — the agent target table.
 *
 * Each AgentTarget knows how to detect its CLI (binary on PATH or a config
 * marker on disk), where its MCP/extension config lives, and which writer
 * format applies. The one MCP server (`prometheus` → `npx -y @prometheus-plugin/mcp`)
 * is registered into every detected agent.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type Format =
  | "json-mcpServers" // {mcpServers:{prometheus:{...}}}
  | "json-contextServers" // zed: {context_servers:{prometheus:{source:"custom",...}}}
  | "json-cline" // cline: mcpServers + disabled/autoApprove
  | "toml-mcpServers" // codex: [mcp_servers.prometheus]
  | "yaml-list" // continue: mcpServers: [ {name,...} ]
  | "gemini-extension"; // own dir, whole-file write

export interface AgentTarget {
  id: string;
  label: string;
  binaries: string[]; // executables to probe on PATH
  markers: string[]; // config dirs/files (~ expanded) whose presence = installed
  /** absolute config path to write/merge (user scope) */
  configPath: string;
  format: Format;
  /** post-install reminder shown to the user */
  note: string;
  /**
   * If set AND its binary is present, register via the agent's OWN CLI instead
   * of hand-editing its config (more format-stable, e.g. `claude mcp add`).
   * Returns argv after the binary name, or null to fall back to the file writer.
   */
  cliRegister?: (pyPath: string, launch: Launch) => { bin: string; argv: string[] } | null;
}

/** How the agent's CLI is told to START the MCP server. */
export type LaunchMode = "local" | "npx";
export interface Launch {
  command: string; // "node" (local) | "npx" (published)
  args: string[];
}

/**
 * Locate the BUILT MCP server entry (`mcp-server/dist/server.js`) for local
 * mode. Resolved relative to this installer package, with a $PROMETHEUS_MCP_SERVER
 * override. Returns the path even if absent so the caller can warn/build.
 */
export function resolveServerJs(): string {
  if (process.env.PROMETHEUS_MCP_SERVER) return process.env.PROMETHEUS_MCP_SERVER;
  const here = dirname(fileURLToPath(import.meta.url)); // installer/dist
  const cands = [
    join(here, "..", "..", "mcp-server", "dist", "server.js"), // sibling package (repo layout)
    join(here, "..", "node_modules", "@prometheus-plugin", "mcp", "dist", "server.js"),
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return cands[0];
}

/** Build the launch command for the chosen mode. */
export function buildLaunch(mode: LaunchMode, serverJs: string): Launch {
  return mode === "npx"
    ? { command: "npx", args: ["-y", "@prometheus-plugin/mcp"] }
    : { command: process.execPath, args: [serverJs] }; // absolute `node` + built server.js
}

const HOME = homedir();
const h = (...p: string[]) => join(HOME, ...p);

export function commandExists(bin: string): boolean {
  try {
    execSync(process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`, {
      stdio: "ignore",
      shell: process.platform === "win32" ? undefined : "/bin/sh",
    });
    return true;
  } catch {
    return false;
  }
}

export function present(t: AgentTarget): boolean {
  if (t.binaries.some(commandExists)) return true;
  return t.markers.some((m) => existsSync(m));
}

/** Server entry shared by every JSON/TOML/YAML manifest. */
export function serverEntry(pyPath: string, launch: Launch) {
  return {
    command: launch.command,
    args: launch.args,
    env: { PROMETHEUS_PY: pyPath },
  };
}

export const AGENTS: AgentTarget[] = [
  {
    id: "claude",
    label: "Claude Code",
    binaries: ["claude"],
    markers: [h(".claude.json"), h(".claude")],
    configPath: h(".claude.json"), // fallback only; the CLI manages its own store
    format: "json-mcpServers",
    note: "run `/mcp` in a Claude session and approve the 'prometheus' server.",
    // Prefer `claude mcp add` — it writes the right scope/structure itself, which
    // is more robust than hand-editing ~/.claude.json (a complex per-project file).
    cliRegister: (py, launch) => ({
      bin: "claude",
      argv: [
        "mcp", "add", "prometheus", "--scope", "user",
        "--env", `PROMETHEUS_PY=${py}`,
        "--", launch.command, ...launch.args,
      ],
    }),
  },
  {
    id: "cursor",
    label: "Cursor",
    binaries: ["cursor", "cursor-agent"],
    markers: [h(".cursor")],
    configPath: h(".cursor", "mcp.json"),
    format: "json-mcpServers",
    note: "open Cursor → Settings → MCP and toggle 'prometheus' on.",
  },
  {
    id: "codex",
    label: "OpenAI Codex CLI",
    binaries: ["codex"],
    markers: [h(".codex")],
    configPath: h(".codex", "config.toml"),
    format: "toml-mcpServers",
    note: "verify with `codex mcp list`.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    binaries: ["gemini"],
    markers: [h(".gemini")],
    configPath: h(".gemini", "extensions", "prometheus", "gemini-extension.json"),
    format: "gemini-extension",
    note: "restart Gemini CLI; the extension auto-loads its MCP server.",
  },
  {
    id: "windsurf",
    label: "Windsurf (Codeium)",
    binaries: ["windsurf"],
    markers: [h(".codeium", "windsurf")],
    configPath: h(".codeium", "windsurf", "mcp_config.json"),
    format: "json-mcpServers",
    note: "in Windsurf, refresh MCP servers (Cascade → MCP).",
  },
  {
    id: "zed",
    label: "Zed",
    binaries: ["zed"],
    markers: [h(".config", "zed")],
    configPath: h(".config", "zed", "settings.json"),
    format: "json-contextServers",
    note: "restart Zed; check the context server shows a green dot.",
  },
  {
    id: "continue",
    label: "Continue",
    binaries: ["cn"],
    markers: [h(".continue")],
    configPath: h(".continue", "config.yaml"),
    format: "yaml-list",
    note: "Continue exposes MCP tools in Agent mode only.",
  },
  {
    id: "cline",
    label: "Cline (VS Code)",
    binaries: [],
    // Cline stores MCP settings in the VS Code extension's globalStorage. Path
    // differs per editor build; cover the common macOS/Linux locations.
    markers: [
      h("Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
      h(".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
    ],
    configPath:
      process.platform === "darwin"
        ? h("Library", "Application Support", "Code", "User", "globalStorage",
            "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
        : h(".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev",
            "settings", "cline_mcp_settings.json"),
    format: "json-cline",
    note: "reload the VS Code window; Cline picks up the new MCP server.",
  },
];
