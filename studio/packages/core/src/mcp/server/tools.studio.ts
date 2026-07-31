/**
 * mcp/server/tools.studio.ts — studio-local tool extensions (file 09 §1.1 / §9).
 *
 * Five new ToolDefs that map 1:1 to existing `cmd_*` functions in prometheus.py
 * (cmd_models ~9553, cmd_apps ~5582, cmd_worldsim ~5732, cmd_localai ~6001) plus
 * the read-only `prometheus_mcp_discover` (the §2.3 union of installed MCP servers).
 * Same dependency-free FieldSpec contract + `[...globalFlags, subcmd, ...]` toArgv
 * as the 14 ported tools (tools.ts).
 *
 * The action-dispatch tools (models/apps/worldsim) CAN mutate, so their annotation
 * is worst-case `destructiveHint` — the §4.3 broker then always confirms them, even
 * for a read action (safe-by-default). localai + mcp_discover are pure reads.
 */
import { type FieldSpec, type ToolDef, argHelpers } from "./tools.js";

const { s, on } = argHelpers;

/** Optional global flags (mutating tools accept --dry-run/--yes/--force). */
function globals(a: Record<string, unknown>): string[] {
  return [
    ...(on(a.dryRun) ? ["--dry-run"] : []),
    ...(on(a.yes) ? ["--yes"] : []),
    ...(on(a.force) ? ["--force"] : []),
  ];
}

const MUTATING = { destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;
const flag = (): FieldSpec => ({ type: "boolean", default: false });
const optStr = (description?: string): FieldSpec => ({ type: "string", description });

export const STUDIO_TOOLS: ToolDef[] = [
  {
    name: "prometheus_models",
    title: "Manage local model tools",
    description:
      "List or manage model build-tools (e.g. FlashAttention): list/install/uninstall/" +
      "update/enable/disable/status/versions/rollback. Mutating actions are gated.",
    schema: {
      action: {
        type: "enum",
        required: true,
        enum: [
          "list",
          "install",
          "uninstall",
          "update",
          "enable",
          "disable",
          "status",
          "versions",
          "rollback",
        ],
        description: "the model-tool action",
      },
      tool: optStr("model-tool id (omit for list)"),
      path: optStr(),
      method: optStr(),
      target_python: optStr(),
      max_jobs: { type: "number", description: "parallel build jobs" },
      cuda: optStr(),
      fa_version: optStr(),
      dryRun: flag(),
      yes: flag(),
      force: flag(),
    },
    annotations: MUTATING,
    toArgv: (a) => [
      ...globals(a),
      "models",
      s(a.action),
      ...(a.tool ? [s(a.tool)] : []),
      ...(a.path ? ["--path", s(a.path)] : []),
      ...(a.method ? ["--method", s(a.method)] : []),
      ...(a.target_python ? ["--target_python", s(a.target_python)] : []),
      ...(a.max_jobs != null ? ["--max_jobs", s(a.max_jobs)] : []),
      ...(a.cuda ? ["--cuda", s(a.cuda)] : []),
      ...(a.fa_version ? ["--fa_version", s(a.fa_version)] : []),
    ],
  },
  {
    name: "prometheus_apps",
    title: "Manage app tools",
    description:
      "List or manage repo-backed app tools: list/wizard/installed/update-all/install/" +
      "uninstall/enable/disable/status/versions/rollback. Mutating actions are gated.",
    schema: {
      action: {
        type: "enum",
        required: true,
        enum: [
          "list",
          "wizard",
          "installed",
          "update-all",
          "install",
          "uninstall",
          "enable",
          "disable",
          "status",
          "versions",
          "rollback",
        ],
      },
      tool: optStr(),
      path: optStr(),
      version: optStr(),
      dryRun: flag(),
      yes: flag(),
      force: flag(),
    },
    annotations: MUTATING,
    toArgv: (a) => [
      ...globals(a),
      "apps",
      s(a.action),
      ...(a.tool ? [s(a.tool)] : []),
      ...(a.path ? ["--path", s(a.path)] : []),
      ...(a.version ? ["--version", s(a.version)] : []),
    ],
  },
  {
    name: "prometheus_worldsim",
    title: "Manage world-simulation tools",
    description:
      "List or manage world-simulation tools (mirrors apps): list/wizard/installed/install/" +
      "uninstall/enable/disable/status/versions/rollback. Mutating actions are gated.",
    schema: {
      action: {
        type: "enum",
        required: true,
        enum: [
          "list",
          "wizard",
          "installed",
          "install",
          "uninstall",
          "enable",
          "disable",
          "status",
          "versions",
          "rollback",
        ],
      },
      tool: optStr(),
      path: optStr(),
      version: optStr(),
      dryRun: flag(),
      yes: flag(),
      force: flag(),
    },
    annotations: MUTATING,
    toArgv: (a) => [
      ...globals(a),
      "worldsim",
      s(a.action),
      ...(a.tool ? [s(a.tool)] : []),
      ...(a.path ? ["--path", s(a.path)] : []),
      ...(a.version ? ["--version", s(a.version)] : []),
    ],
  },
  {
    name: "prometheus_localai",
    title: "Local-AI audit & info",
    description:
      "Read-only local-AI surface: audit (default) / list / models / endpoints / show / model. " +
      "Never mutates — prints the open-model + endpoint inventory.",
    schema: {
      action: {
        type: "enum",
        enum: ["audit", "list", "models", "endpoints", "show", "model"],
        default: "audit",
      },
      tool: optStr("ai-tool or open-model id (for show/model)"),
    },
    annotations: { readOnlyHint: true },
    toArgv: (a) => ["localai", s(a.action ?? "audit"), ...(a.tool ? [s(a.tool)] : [])],
  },
  {
    name: "prometheus_mcp_discover",
    title: "Discover installed MCP servers",
    description:
      "Read-only: the union of MCP servers already configured across detected agent CLIs " +
      "(Claude/Cursor/Codex/Windsurf/Zed/Continue/Cline). Used to offer 'Import N servers'.",
    schema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
    toArgv: () => ["mcp", "discover"],
  },
];
