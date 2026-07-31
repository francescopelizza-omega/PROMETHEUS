/**
 * commands/registry.ts — the SHARED command registry.
 *
 * This is the single surface BOTH the `prom` CLI and the desktop GUI render:
 * one list of commands, each with a stable id, a title, a group, and a `run(ctx)`
 * that drives the engine through the @prometheus/engine-bridge EngineClient.
 *
 * GOLDEN RULE (C5): commands NEVER decide "safe". The `gate` command renders the
 * engine-bridge nemesis verdict; everything security-relevant is an engine call.
 * No command spawns python3/nemesis itself — it goes through the injected client.
 *
 * Node built-ins only. The registry is data + thin closures; the GUI iterates it
 * to build a palette, the CLI maps argv[0] -> command id.
 */
import type {
  EngineClient,
  EngineEnvelope,
  RunOptions,
  SecurityVerdict,
} from "@prometheus/engine-bridge";

import type { Provider } from "../domain/models.js";
import {
  type PromotionContext,
  classifyTier,
  costLight,
  loadProviders,
  needsCostWarning,
  sortByPromotion,
} from "../providers/policy.js";

/** Logical grouping for the GUI command palette / CLI help sections. */
export type CommandGroup = "inventory" | "security" | "environments" | "models" | "providers";

/**
 * The context handed to every command's run(). It carries the engine client
 * (the ONLY engine gateway), positional args, options, and config locations.
 */
export interface CommandContext {
  client: EngineClient;
  /** positional arguments (e.g. the plugin NAME for info/install). */
  args: string[];
  /** pass-through run options (cwd/timeout/signal/onStderr). */
  opts?: RunOptions;
  /** provider-config path override (defaults to the bundled config). */
  providersConfigPath?: string;
  /** runtime promotion proof for provider tiering (C11). */
  promotionContext?: PromotionContext;
}

/** The normalised result every command resolves to. */
export interface CommandResult {
  id: string;
  ok: boolean;
  /** the raw engine envelope, when the command was an engine call. */
  envelope?: EngineEnvelope;
  /** a security verdict, for the gate command. */
  verdict?: SecurityVerdict;
  /** structured provider rows, for provider-list. */
  providers?: ProviderRow[];
  /** a short human summary line for the CLI / GUI toast. */
  summary: string;
}

/** A provider row enriched with its EFFECTIVE tier + cost light (C11). */
export interface ProviderRow {
  provider: Provider;
  tier: "A" | "B" | "C";
  costLight: "green" | "blue" | "red";
  needsCostWarning: boolean;
}

/** A registered command: the unit BOTH surfaces render. */
export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  description: string;
  /** does this command require a positional name arg (info/install/status/gate)? */
  needsArg?: boolean;
  run(ctx: CommandContext): Promise<CommandResult>;
}

/** Build the summary line for a plain engine envelope. */
function summarize(id: string, env: EngineEnvelope): string {
  if (env.ok === false) {
    const reason = typeof env.error === "string" ? env.error : "engine returned ok:false";
    return `${id}: ${reason}`;
  }
  return `${id}: ok`;
}

function envResult(id: string, env: EngineEnvelope): CommandResult {
  return { id, ok: env.ok !== false, envelope: env, summary: summarize(id, env) };
}

/** Require a positional name arg or throw a clear error. */
function requireName(ctx: CommandContext, id: string): string {
  const name = ctx.args[0];
  if (!name || !name.trim()) {
    throw new Error(`command "${id}" requires a name argument`);
  }
  return name;
}

/**
 * The seeded command registry. The functions close over nothing — they read the
 * client/args from the passed CommandContext, so a single frozen registry is
 * shared safely across every CLI invocation and GUI render.
 */
export const COMMANDS: readonly Command[] = Object.freeze([
  {
    id: "scan",
    title: "Scan agents",
    group: "inventory",
    description: "Inventory installed AI agents/CLIs/IDEs the engine detects (prometheus.py scan).",
    async run(ctx) {
      const env = await ctx.client.scan(ctx.opts);
      const agents = Array.isArray(env.agents) ? (env.agents as unknown[]) : [];
      const present = agents.filter(
        (a) => a && typeof a === "object" && (a as Record<string, unknown>).present === true,
      ).length;
      return {
        ...envResult("scan", env),
        summary:
          env.ok === false
            ? summarize("scan", env)
            : `scan: ${present}/${agents.length} agents present`,
      };
    },
  },
  {
    id: "list",
    title: "List plugins",
    group: "inventory",
    description: "List the installable plugin/agent registry (prometheus.py list).",
    async run(ctx) {
      const env = await ctx.client.list(ctx.opts);
      return envResult("list", env);
    },
  },
  {
    id: "gate",
    title: "Gate a target",
    group: "security",
    description:
      "Security-gate an arbitrary path / git URL / owner-repo through nemesis (C4). Fail-closed.",
    needsArg: true,
    async run(ctx) {
      const target = requireName(ctx, "gate");
      // gate() is fail-closed: a missing/timed-out scanner => verdict "error".
      const verdict = await ctx.client.gate(target, ctx.opts);
      const blocked = verdict.verdict === "block" || verdict.verdict === "error";
      return {
        id: "gate",
        ok: !blocked,
        verdict,
        summary: `gate ${target}: ${verdict.verdict} (risk ${verdict.risk_score}, ${verdict.findings.length} findings)`,
      };
    },
  },
  {
    id: "env-list",
    title: "List environments",
    group: "environments",
    description: "List Python environments (venv/conda/system) via the envmgr sidecar (env.list).",
    async run(ctx) {
      // The env.* verbs are served by the python sidecar through prometheus.py's
      // sidecar bridge; we invoke it via the generic runPrometheus passthrough so
      // engine-bridge stays the only spawner (C5).
      const env = await ctx.client.runPrometheus(["sidecar", "envmgr", "env.list"], ctx.opts);
      const envs = Array.isArray(env.environments) ? (env.environments as unknown[]) : [];
      return {
        ...envResult("env-list", env),
        summary:
          env.ok === false ? summarize("env-list", env) : `env-list: ${envs.length} environments`,
      };
    },
  },
  {
    id: "model-hw",
    title: "Scan hardware for model fit",
    group: "models",
    description:
      "Probe host hardware (CPU/RAM/GPU/unified memory) for model-fit scoring (modelhub hw.scan).",
    async run(ctx) {
      const env = await ctx.client.runPrometheus(["sidecar", "modelhub", "hw.scan"], ctx.opts);
      const gb =
        typeof env.usable_weight_gb === "number"
          ? `${env.usable_weight_gb} GB usable`
          : "hw scanned";
      return {
        ...envResult("model-hw", env),
        summary: env.ok === false ? summarize("model-hw", env) : `model-hw: ${gb}`,
      };
    },
  },
  {
    id: "provider-list",
    title: "List providers",
    group: "providers",
    description:
      "List inference providers with their promotion tier + cost light (C11). Tier-A first.",
    async run(ctx) {
      const providers = await loadProviders(ctx.providersConfigPath);
      const sorted = sortByPromotion(providers, ctx.promotionContext);
      const rows: ProviderRow[] = sorted.map((p) => ({
        provider: p,
        tier: classifyTier(p, ctx.promotionContext),
        costLight: costLight(p, ctx.promotionContext),
        needsCostWarning: needsCostWarning(p, ctx.promotionContext),
      }));
      const tierA = rows.filter((r) => r.tier === "A").length;
      return {
        id: "provider-list",
        ok: true,
        providers: rows,
        summary: `provider-list: ${rows.length} providers (${tierA} Tier-A)`,
      };
    },
  },
]);

/** O(1) lookup of a command by id. */
const BY_ID = new Map<string, Command>(COMMANDS.map((c) => [c.id, c]));

/** Find a command by id (undefined if unknown). */
export function getCommand(id: string): Command | undefined {
  return BY_ID.get(id);
}

/** Every command in registration order (the GUI palette / CLI help order). */
export function listCommands(): readonly Command[] {
  return COMMANDS;
}

/** Commands in one group (e.g. for sectioned CLI help). */
export function commandsByGroup(group: CommandGroup): Command[] {
  return COMMANDS.filter((c) => c.group === group);
}

/** Run a command by id, throwing a clear error for an unknown id. */
export async function runCommandById(id: string, ctx: CommandContext): Promise<CommandResult> {
  const cmd = BY_ID.get(id);
  if (!cmd) throw new Error(`unknown command: ${id}`);
  return cmd.run(ctx);
}
