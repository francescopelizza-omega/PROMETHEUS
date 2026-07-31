/**
 * tools.ts — the MCP tool catalog.
 *
 * Each ToolDef declares its name, description, a raw zod *shape* (object of
 * field→ZodType, NOT z.object(...) — the SDK wraps it), annotations, and a
 * `toArgv(args)` that maps validated input to a prometheus.py command line.
 * Global flags (e.g. --dry-run) MUST come before the subcommand; the bridge
 * prepends --json/--no-color, so toArgv returns [...globalFlags, subcmd, ...].
 */
import { z } from "zod";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  toArgv: (a: Record<string, any>) => string[];
}

const RO = { readOnlyHint: true };

/**
 * Option-injection guard for a POSITIONAL target (CLI-035): a value that could start with
 * `-` (a plugin/app/model/skill id) is placed after a literal `--` so the engine's argparse
 * reads it as a positional, never as flags. Returns [] for an absent value.
 */
function pos(value: string | undefined): string[] {
  return value && value.length > 0 ? ["--", value] : [];
}

/**
 * Deterministically render the tool table to Markdown (CLI-035 docs/TOOLS.md). Pure over the
 * tool list, so the reference can NEVER drift by hand — regenerate with `npm run docs`.
 */
export function renderToolsDoc(tools: ToolDef[]): string {
  const lines: string[] = [
    "# Prometheus MCP tools",
    "",
    "> Generated from `src/tools.ts` by `npm run docs` — do not edit by hand.",
    "",
    `**${tools.length}** tools exposed to MCP clients.`,
    "",
  ];
  for (const t of tools) {
    lines.push(`## \`${t.name}\``, "", t.description, "");
    lines.push(`- **destructive:** ${t.annotations.destructiveHint ? "yes" : "no"}`);
    const fields = Object.entries(t.schema);
    if (fields.length === 0) {
      lines.push("- **params:** none");
    } else {
      lines.push("- **params:**");
      for (const [name, zt] of fields) {
        const desc = (zt as any)?._def?.description ?? "";
        lines.push(`  - \`${name}\` — ${desc}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export const TOOLS: ToolDef[] = [
  {
    name: "prometheus_scan",
    title: "Scan for AI agents",
    description:
      "Detect which AI agent CLIs (Claude Code, Codex, Cursor, Gemini, Windsurf, " +
      "Zed, Continue, Copilot, …) are installed on this machine. Returns each " +
      "agent with present/absent and where it was found.",
    schema: {},
    annotations: { ...RO, openWorldHint: true },
    toArgv: () => ["scan"],
  },
  {
    name: "prometheus_superscan",
    title: "Full agent inventory",
    description:
      "Deep inventory of every known agent: present/forgotten state, binary + " +
      "version, config dir, staleness, and per-agent counts of installed " +
      "plugins/skills/MCP/extensions/rules/commands, plus host prerequisite tools.",
    schema: {},
    annotations: { ...RO, openWorldHint: true },
    toArgv: () => ["superscan"],
  },
  {
    name: "prometheus_list",
    title: "List the plugin registry",
    description:
      "The full Prometheus plugin catalog with per-agent install state. Each entry " +
      "has tier, summary, repo, scope (claude-only/universal) and a targets map.",
    schema: {},
    annotations: RO,
    toArgv: () => ["list"],
  },
  {
    name: "prometheus_info",
    title: "Plugin details",
    description: "Full metadata for one plugin: summary, tier, repo, automation, " +
      "security note, caveats, install targets and selectable components.",
    schema: { name: z.string().min(1).describe("registry plugin name (see prometheus_list)") },
    annotations: RO,
    toArgv: (a) => ["info", a.name],
  },
  {
    name: "prometheus_where",
    title: "Where a plugin installs",
    description: "Show exactly where a plugin would install (per-agent method + " +
      "destination path) BEFORE installing it.",
    schema: { name: z.string().min(1).describe("registry plugin name") },
    annotations: RO,
    toArgv: (a) => ["where", a.name],
  },
  {
    name: "prometheus_status",
    title: "Plugin install/enable state",
    description: "Install + enable/disable state of a plugin and its components " +
      "across every targeted agent. Pass 'all' for the whole registry.",
    schema: { name: z.string().min(1).describe("registry plugin name, or 'all'") },
    annotations: RO,
    toArgv: (a) => ["status", a.name],
  },
  {
    name: "prometheus_audit",
    title: "Security-audit a plugin",
    description:
      "Static security audit of a plugin's install artifacts (no install): the " +
      "built-in regex scan PLUS the deep nemesis gate verdict per remote source. " +
      "Returns active findings, downgraded count and a worst verdict. Use 'all' " +
      "to audit the whole registry.",
    schema: {
      name: z.string().min(1).describe("registry plugin name, or 'all'"),
    },
    annotations: RO,
    toArgv: (a) => ["audit", a.name],
  },
  {
    name: "prometheus_matrix",
    title: "Reach matrix",
    description: "Which plugin can go into which agent: native, via-sync, or " +
      "unavailable, for every registry plugin.",
    schema: {},
    annotations: RO,
    toArgv: () => ["matrix"],
  },
  {
    name: "prometheus_skills_list",
    title: "List installed skills",
    description: "List installed SKILL.md folders (~/.claude/skills) with their " +
      "enabled/disabled/muted state.",
    schema: {},
    annotations: RO,
    toArgv: () => ["skills", "list"],
  },
  {
    name: "prometheus_vault_status",
    title: "Repo Vault status",
    description: "Status of the offline Repo Vault: known repos and which versions " +
      "are stored locally. (invoke/rollback are interactive and not exposed here.)",
    schema: {},
    annotations: RO,
    toArgv: () => ["vault"],
  },
  // ---- state-changing tools -------------------------------------------- //
  {
    name: "prometheus_install",
    title: "Install a plugin (gated)",
    description:
      "Install a registry plugin (or 'all' / 'official-bundle') into every detected " +
      "target agent. nemesis seeds/refreshes its malware DB and scans the code FIRST — " +
      "a DANGEROUS (block-verdict) plugin is reported as a 'blocked' event and NOT " +
      "installed. ALWAYS preview with dryRun:true first; set yes:true only when the user " +
      "approved non-critical findings. To install code nemesis flagged as DANGEROUS, the " +
      "user must explicitly approve it — set force:true (equivalent to `/prometheus " +
      "--force`); the result then carries a `forced_danger` block and ok:false.",
    schema: {
      name: z.string().min(1).describe("registry plugin name, 'all', or 'official-bundle'"),
      only: z.string().optional().describe("component selection, e.g. a sub-plugin id"),
      dryRun: z.boolean().default(true).describe("preview without changing anything (default true)"),
      yes: z.boolean().default(false).describe("auto-approve non-critical gate findings"),
      strict: z.boolean().default(false).describe("block on medium-or-higher findings too"),
      force: z.boolean().default(false).describe(
        "DANGER: override a nemesis BLOCK and install code flagged as malicious/unsafe. " +
        "Only set when the user has explicitly accepted the risk for THIS source.",
      ),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    toArgv: (a) => [
      ...(a.dryRun ? ["--dry-run"] : []),
      ...(a.yes ? ["--yes"] : []),
      ...(a.strict ? ["--strict"] : []),
      ...(a.force ? ["--force"] : []),
      "install", a.name,
      ...(a.only ? ["--only", a.only] : []),
    ],
  },
  {
    name: "prometheus_uninstall",
    title: "Uninstall a plugin",
    description:
      "Remove a registry plugin (or 'all' / 'official-bundle') from every detected " +
      "agent. Preview with dryRun:true first. Foreign (non-registry) ids are not " +
      "removable through this tool.",
    schema: {
      name: z.string().min(1).describe("registry plugin name, 'all', or 'official-bundle'"),
      only: z.string().optional().describe("component selection"),
      dryRun: z.boolean().default(true).describe("preview without changing anything (default true)"),
      yes: z.boolean().default(false).describe(
        "confirm the removal — REQUIRED for a real (non-dry-run) uninstall, since " +
        "the engine is non-interactive here and otherwise declines",
      ),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    toArgv: (a) => [
      ...(a.dryRun ? ["--dry-run"] : []),
      ...(a.yes ? ["--yes"] : []),
      "uninstall", a.name,
      ...(a.only ? ["--only", a.only] : []),
    ],
  },
  {
    name: "prometheus_enable",
    title: "Enable a plugin/component",
    description: "Re-arm a disabled plugin or component (reversible).",
    schema: {
      name: z.string().min(1).describe("registry plugin name (optionally name:selection)"),
      component: z.enum(["hooks", "mcp"]).optional()
        .describe("toggle the plugin's on-disk hooks or MCP servers"),
    },
    annotations: { idempotentHint: true },
    toArgv: (a) => ["enable", a.name, ...(a.component ? ["--component", a.component] : [])],
  },
  {
    name: "prometheus_disable",
    title: "Disable a plugin/component",
    description: "Turn off a plugin or component WITHOUT uninstalling it (reversible).",
    schema: {
      name: z.string().min(1).describe("registry plugin name (optionally name:selection)"),
      component: z.enum(["hooks", "mcp"]).optional()
        .describe("toggle the plugin's on-disk hooks or MCP servers"),
    },
    annotations: { idempotentHint: true },
    toArgv: (a) => ["disable", a.name, ...(a.component ? ["--component", a.component] : [])],
  },
  // ---- CLI-035: full read surface (describe/tutorial/methods/doctor/…) --- //
  {
    name: "prometheus_describe",
    title: "Describe a catalog id",
    description:
      "Rich card for any catalog id (plugin / model-tool / app / open-model / documented): " +
      "what it is, where it installs, how, its security note, and the exact install & remove " +
      "commands. Omit the id for the whole catalog index.",
    schema: {
      id: z.string().optional().describe("catalog id (see prometheus_list / prometheus_models)"),
    },
    annotations: RO,
    toArgv: (a) => ["describe", ...pos(a.id)],
  },
  {
    name: "prometheus_tutorial",
    title: "Deep tutorial for an id",
    description:
      "Print the deep tutorial (dossier) for a catalog id — the 'Learn more' surface.",
    schema: { id: z.string().optional().describe("catalog id") },
    annotations: RO,
    toArgv: (a) => ["tutorial", ...pos(a.id)],
  },
  {
    name: "prometheus_methods",
    title: "Install methods for an id",
    description: "List every install method documented for a catalog id.",
    schema: { id: z.string().optional().describe("catalog id") },
    annotations: RO,
    toArgv: (a) => ["methods", ...pos(a.id)],
  },
  {
    name: "prometheus_doctor",
    title: "Environment doctor",
    description: "Check the host OS, detected agents, git, and resolved paths.",
    schema: {},
    annotations: RO,
    toArgv: () => ["doctor"],
  },
  {
    name: "prometheus_inventory",
    title: "Full per-agent inventory",
    description:
      "Re-scan every detected agent for ALL installed plugins/skills/MCP (managed AND foreign). " +
      "Optionally restrict to specific detected agents.",
    schema: {
      host: z
        .array(z.string())
        .optional()
        .describe("restrict to these detected agents (e.g. ['claude','gemini'])"),
    },
    annotations: RO,
    toArgv: (a) => ["inventory", ...((a.host ?? []) as string[]).flatMap((h) => ["--host", h])],
  },
  {
    name: "prometheus_models",
    title: "Model-tool catalog (read)",
    description:
      "3rd functionality — the local/cloud model-running tools (AirLLM, FlashAttention, …): " +
      "list the catalog, show install status/versions, browse, or show the config folder. " +
      "Read-only subactions only; installs/updates go through the gated engine directly.",
    schema: {
      action: z
        .enum(["list", "status", "versions", "browse", "config"])
        .default("list")
        .describe("which read view (config = show the default models folder)"),
      tool: z.string().optional().describe("tool id (airllm|flashattention|…) for status/versions"),
    },
    annotations: RO,
    toArgv: (a) => ["models", a.action, ...(a.action === "config" ? ["--show"] : []), ...pos(a.tool)],
  },
  {
    name: "prometheus_apps",
    title: "Self-hosted apps (read)",
    description:
      "4th functionality — self-hosted apps & repos (yt-dlp, ollama, n8n, penpot, …): list the " +
      "catalog, show installed apps, status, versions, or logs. Read-only subactions only.",
    schema: {
      action: z
        .enum(["list", "installed", "status", "versions", "logs"])
        .default("list")
        .describe("which read view"),
      tool: z.string().optional().describe("app id (see the list action)"),
    },
    annotations: RO,
    toArgv: (a) => ["apps", a.action, ...pos(a.tool)],
  },
  {
    name: "prometheus_worldsim",
    title: "World-sim engines (read)",
    description:
      "8th functionality — agent-based world-simulation engines (MiroFish, …): list the catalog, " +
      "show installed engines, status, versions, or logs. Read-only subactions only.",
    schema: {
      action: z
        .enum(["list", "installed", "status", "versions", "logs"])
        .default("list")
        .describe("which read view"),
      tool: z.string().optional().describe("engine id (see the list action)"),
    },
    annotations: RO,
    toArgv: (a) => ["worldsim", a.action, ...pos(a.tool)],
  },
  {
    name: "prometheus_secure",
    title: "Nemesis scan a target",
    description:
      "Scan any file / archive / folder / git URL / owner-repo for threats with the nemesis " +
      "engine and report the verdict. A READ-only scan (nothing is modified). Use full:true to " +
      "scan the whole home directory (slow).",
    schema: {
      target: z
        .string()
        .optional()
        .describe("file, archive, folder, git URL, or owner/repo (omit with full:true)"),
      full: z.boolean().default(false).describe("scan the entire home directory (slow)"),
    },
    annotations: { ...RO, openWorldHint: true },
    toArgv: (a) => ["secure", ...(a.full ? ["--full"] : []), ...pos(a.target)],
  },
  {
    name: "prometheus_harden",
    title: "Defensive self-audit",
    description:
      "Defensive, localhost-only, read-only self-audit of THIS machine (firewall/ports/ssh/" +
      "encryption/secret perms) with hardening steps. Advisory — it changes nothing.",
    schema: {},
    annotations: RO,
    toArgv: () => ["harden"],
  },
  // ---- CLI-035: destructive verb, confirm-gated --------------------------- //
  {
    name: "prometheus_sync",
    title: "Sync a skill across agents (gated)",
    description:
      "Replicate an installed SKILL.md into OTHER agents (cross-CLI portability). This WRITES " +
      "files into other agents' config dirs, so it requires an explicit confirm:true — without " +
      "it the engine is never invoked.",
    schema: {
      skill: z.string().min(1).describe("skill folder name in ~/.claude/skills/"),
      to: z.string().optional().describe("target agents (comma-sep) or 'all' (default: all with a skills dir)"),
      confirm: z
        .literal(true)
        .describe("REQUIRED — sync writes into other agents; set true only with the user's OK"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    toArgv: (a) => {
      // defense-in-depth: the schema already rejects a missing confirm, but never build argv
      // for an unconfirmed destructive verb.
      if (a.confirm !== true) throw new Error("confirm-required");
      return ["sync", ...pos(a.skill), ...(a.to ? ["--to", a.to] : [])];
    },
  },
];
