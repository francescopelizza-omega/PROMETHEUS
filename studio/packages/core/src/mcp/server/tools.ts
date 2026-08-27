/**
 * mcp/server/tools.ts — the embedded MCP server's tool catalog (file 09 §1/§3).
 *
 * A faithful, DEPENDENCY-FREE port of `prometheus_plugin/mcp-server/src/tools.ts`
 * (the reused contract, §1.1). We do NOT import that package (it is outside the
 * studio workspace and pulls the MCP SDK), and `@prometheus/core` has NO zod on its
 * resolution path — so the tool `schema` is a small structural FieldSpec descriptor
 * (validated by the pure `validateArgs`, runner.ts) rather than a zod shape. The
 * external SDK-facing server keeps its zod shapes; studio's core only needs the
 * field types to validate/coerce args + render the marketplace.
 *
 * Each ToolDef declares name, schema (FieldSpec map), MCP annotations
 * (readOnlyHint/destructiveHint/idempotentHint/openWorldHint — the SINGLE source the
 * §4.3 confirm policy reads), and a `toArgv` mapping validated input to a
 * prometheus.py command line. GLOBAL FLAGS precede the subcommand; the bridge
 * prepends --json/--no-color, so toArgv returns `[...globalFlags, subcmd, ...]`.
 */

/** MCP tool annotations — the SINGLE source the confirm/auto-approve policy reads (§4.3). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A single argument's type + constraints (dependency-free; mirrors a zod field).
 *
 * `array` was added because two tools were LYING about their arguments. `propose_edit.hunks`
 * is `Array<{old,new}>` and `propose_elevated.argv` is `string[]`, but with no array type to
 * declare, both were typed `string` with a description that contradicted it. That reached the
 * model as `hunks*: string` on the single most important tool for editing code — so the model
 * dutifully sent a string, and only `parseHunks`' array-or-JSON-string tolerance kept it
 * working at all. A schema that disagrees with its own description is a schema the model
 * cannot follow.
 *
 * `items` describes the ELEMENT type. It is deliberately shallow: nothing here needs a full
 * recursive JSON Schema, and a shallow hint plus a precise description is what actually
 * lands with a small local model.
 */
export interface FieldSpec {
  type: "string" | "boolean" | "number" | "enum" | "array";
  required?: boolean;
  default?: string | boolean | number;
  enum?: readonly string[];
  description?: string;
  /** for `type:"array"` — the element type, and optionally a shape note for the prompt. */
  items?: { type: "string" | "boolean" | "number" | "object"; shape?: string };
}

/** A tool's argument schema: field name → spec. */
export type ToolSchema = Record<string, FieldSpec>;

/** A tool definition: name + schema + annotations + argv mapper. */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: ToolSchema;
  annotations: ToolAnnotations;
  /** map validated args → prometheus.py argv ([...globalFlags, subcmd, ...]). */
  toArgv: (a: Record<string, unknown>) => string[];
}

/* ── coercion helpers (args are validated by runner before toArgv runs) ──────── */
const s = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const on = (v: unknown): boolean => v === true;

const RO: ToolAnnotations = { readOnlyHint: true };
const req = (description: string): FieldSpec => ({ type: "string", required: true, description });
const optStr = (description?: string): FieldSpec => ({ type: "string", description });
const flag = (description?: string): FieldSpec => ({
  type: "boolean",
  default: false,
  description,
});

/** The 14 ported tools — VERBATIM names/annotations/argv from the reused server. */
export const PROMETHEUS_TOOLS: ToolDef[] = [
  {
    name: "prometheus_scan",
    title: "Scan for AI agents",
    description:
      "Detect which AI agent CLIs (Claude Code, Codex, Cursor, Gemini, Windsurf, Zed, " +
      "Continue, Copilot, …) are installed on this machine.",
    schema: {},
    // NOT openWorldHint: this inspects THIS machine and reaches no external entity. The hint is
    // for tools that touch an open world (a web search); a local inventory is the closed-world
    // case. It mattered once `openWorldHint` started outranking `readOnlyHint` in classifyAuth:
    // the mislabel would have pushed a purely local read into the network tier.
    annotations: { ...RO },
    toArgv: () => ["scan"],
  },
  {
    name: "prometheus_superscan",
    title: "Full agent inventory",
    description:
      "Deep inventory of every known agent: present/forgotten, binary + version, config " +
      "dir, staleness, and per-agent counts of plugins/skills/MCP/extensions/rules/commands.",
    schema: {},
    // NOT openWorldHint — a deeper inventory of the SAME local machine. See prometheus_scan.
    annotations: { ...RO },
    toArgv: () => ["superscan"],
  },
  {
    name: "prometheus_list",
    title: "List the plugin registry",
    description:
      "The full Prometheus plugin catalog with per-agent install state (tier, summary, " +
      "repo, scope, targets map).",
    schema: {},
    annotations: RO,
    toArgv: () => ["list"],
  },
  {
    name: "prometheus_info",
    title: "Plugin details",
    description:
      "Full metadata for one plugin: summary, tier, repo, automation, security note, " +
      "caveats, install targets and selectable components.",
    schema: { name: req("registry plugin name (see prometheus_list)") },
    annotations: RO,
    toArgv: (a) => ["info", s(a.name)],
  },
  {
    name: "prometheus_where",
    title: "Where is a plugin installed",
    description: "Show which detected agents currently have a given plugin installed.",
    schema: { name: req("registry plugin name") },
    annotations: RO,
    toArgv: (a) => ["where", s(a.name)],
  },
  {
    name: "prometheus_status",
    title: "Plugin install status",
    description: "Per-agent enabled/installed/disabled/muted/absent/missing state for one plugin.",
    schema: { name: req("registry plugin name") },
    annotations: RO,
    toArgv: (a) => ["status", s(a.name)],
  },
  {
    name: "prometheus_audit",
    title: "Security audit a plugin",
    description:
      "Run nemesis static analysis on a REGISTRY plugin and return the verdict + findings. " +
      "Read-only: scans, never installs. A high/critical worst_verdict is an error.",
    schema: { name: req("registry plugin name") },
    annotations: RO,
    toArgv: (a) => ["audit", s(a.name)],
  },
  {
    name: "prometheus_matrix",
    title: "Reach matrix",
    description: "The plugin × agent reach matrix (native vs sync) across detected agents.",
    schema: {},
    annotations: RO,
    toArgv: () => ["matrix"],
  },
  {
    name: "prometheus_skills_list",
    title: "List installed skills",
    description: "Installed SKILL.md folders with enabled/disabled/muted state.",
    schema: {},
    annotations: RO,
    toArgv: () => ["skills", "list"],
  },
  {
    name: "prometheus_vault_status",
    title: "Quarantine vault status",
    description: "The nemesis quarantine vault: count + entries of quarantined artifacts.",
    schema: {},
    annotations: RO,
    toArgv: () => ["vault"],
  },
  {
    name: "prometheus_install",
    title: "Install a plugin",
    description:
      "Install a registry plugin into every detected agent target. DESTRUCTIVE: defaults " +
      "dryRun:true (scans + plans only). Set yes:true ONLY after a human approves the " +
      "nemesis findings. Use force:true only to override a BLOCK verdict (typed-confirm).",
    schema: {
      name: req("registry plugin name"),
      only: optStr("install only this component (comma-list)"),
      dryRun: { type: "boolean", default: true, description: "plan + scan only; do not write" },
      yes: flag("confirm the install after human approval"),
      strict: flag("strict gate (warn→block)"),
      force: flag("override a BLOCK verdict (deep-red)"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    toArgv: (a) => [
      ...(on(a.dryRun) ? ["--dry-run"] : []),
      ...(on(a.yes) ? ["--yes"] : []),
      ...(on(a.strict) ? ["--strict"] : []),
      ...(on(a.force) ? ["--force"] : []),
      "install",
      s(a.name),
      ...(a.only ? ["--only", s(a.only)] : []),
    ],
  },
  {
    name: "prometheus_uninstall",
    title: "Uninstall a plugin",
    description:
      "Remove a plugin from its agent targets. DESTRUCTIVE: defaults dryRun:true; set " +
      "yes:true to apply.",
    schema: {
      name: req("registry plugin name"),
      only: optStr("uninstall only this component"),
      dryRun: { type: "boolean", default: true },
      yes: flag(),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    toArgv: (a) => [
      ...(on(a.dryRun) ? ["--dry-run"] : []),
      ...(on(a.yes) ? ["--yes"] : []),
      "uninstall",
      s(a.name),
      ...(a.only ? ["--only", s(a.only)] : []),
    ],
  },
  {
    name: "prometheus_enable",
    title: "Enable a plugin component",
    description: "Enable an installed plugin (or one of its components: hooks / mcp).",
    schema: {
      name: req("registry plugin name"),
      component: { type: "enum", enum: ["hooks", "mcp"], description: "component to enable" },
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    toArgv: (a) => ["enable", s(a.name), ...(a.component ? ["--component", s(a.component)] : [])],
  },
  {
    name: "prometheus_disable",
    title: "Disable a plugin component",
    description: "Disable an installed plugin (or one of its components: hooks / mcp).",
    schema: {
      name: req("registry plugin name"),
      component: { type: "enum", enum: ["hooks", "mcp"], description: "component to disable" },
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    toArgv: (a) => ["disable", s(a.name), ...(a.component ? ["--component", s(a.component)] : [])],
  },
];

/** Shared coercion helpers for the studio tool extensions (tools.studio.ts). */
export const argHelpers = { s, on } as const;
