/**
 * cli-profiles/profile.ts — the CLI profile schema + resolve/merge (file 11 §6).
 *
 * A profile bundles agent tuning + engine defaults so a context switches in one
 * keystroke. Stored as TOML, SHARED with the GUI (same files/schema). Resolution:
 * flags > profile > built-in default. `resolveTuning` maps a profile's [agent]
 * section → the universal AgentTuning the loop consumes. PURE.
 */
import type { AgentTuning } from "../agent/loop.js";
import type { ModelRef } from "../agents/types.js";
import { type TomlTable, parseToml, stringifyToml } from "./toml.js";

export interface CliProfile {
  name?: string;
  agent: {
    model: string;
    systemPrompt?: string;
    tools?: { enabled?: boolean; allow?: string[]; deny?: string[] };
    /** max model⇄tool rounds per turn before the loop pauses + offers `/continue` (CLI-072).
     *  Maps to AgentTuning.maxRounds. A value < 1 means "use the default" (never 0 → bricked). */
    maxIterations?: number;
  };
  engine: {
    gateMode?: "enforce" | "warn" | "off";
    dryRun?: boolean;
    yes?: boolean;
    paths?: { prometheusPy?: string; python?: string };
  };
  /** [budget] session/daily USD caps (CLI-030). Absent ⇒ no limit (zero regression). */
  budget?: {
    sessionUsd?: number;
    dailyUsd?: number;
    warnAtPercent?: number;
  };
}

const DEFAULT_SYSTEM =
  "You are Prometheus. Always scan before installing. Prefer free/local tools.";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}
function asTable(v: unknown): TomlTable | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as TomlTable) : undefined;
}

/** Parse a profile TOML → CliProfile (fail-soft null when agent.model is absent). */
export function parseProfile(toml: string, name?: string): CliProfile | null {
  const doc = parseToml(toml);
  const agentT = asTable(doc.agent);
  const model = str(agentT?.model);
  if (!model) return null; // agent.model is the one mandatory field
  const toolsT = asTable(agentT?.tools);
  const maxIterations = num(agentT?.maxIterations);
  const engineT = asTable(doc.engine);
  const pathsT = asTable(engineT?.paths);
  const gateMode = str(engineT?.gateMode);
  const budgetT = asTable(doc.budget);
  // TOML keys are snake_case (session_usd) — mirror the file's existing convention.
  const sessionUsd = num(budgetT?.session_usd);
  const dailyUsd = num(budgetT?.daily_usd);
  const warnAtPercent = num(budgetT?.warn_at_percent);
  const budget =
    sessionUsd !== undefined || dailyUsd !== undefined || warnAtPercent !== undefined
      ? {
          ...(sessionUsd !== undefined ? { sessionUsd } : {}),
          ...(dailyUsd !== undefined ? { dailyUsd } : {}),
          ...(warnAtPercent !== undefined ? { warnAtPercent } : {}),
        }
      : undefined;
  const profile: CliProfile = {
    ...(name ? { name } : {}),
    agent: {
      model,
      ...(str(agentT?.systemPrompt) ? { systemPrompt: str(agentT?.systemPrompt) } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(toolsT
        ? {
            tools: {
              ...(bool(toolsT.enabled) !== undefined ? { enabled: bool(toolsT.enabled) } : {}),
              ...(strArr(toolsT.allow) ? { allow: strArr(toolsT.allow) } : {}),
              ...(strArr(toolsT.deny) ? { deny: strArr(toolsT.deny) } : {}),
            },
          }
        : {}),
    },
    engine: {
      ...(gateMode === "enforce" || gateMode === "warn" || gateMode === "off" ? { gateMode } : {}),
      ...(bool(engineT?.dryRun) !== undefined ? { dryRun: bool(engineT?.dryRun) } : {}),
      ...(bool(engineT?.yes) !== undefined ? { yes: bool(engineT?.yes) } : {}),
      ...(pathsT
        ? {
            paths: {
              ...(str(pathsT.prometheusPy) ? { prometheusPy: str(pathsT.prometheusPy) } : {}),
              ...(str(pathsT.python) ? { python: str(pathsT.python) } : {}),
            },
          }
        : {}),
    },
    ...(budget ? { budget } : {}),
  };
  return profile;
}

/**
 * Serialize a CliProfile → TOML that round-trips through `parseProfile` (CLI-044). Builds a fresh
 * TomlTable (never mutates the frozen builtin seeds) and emits ONLY the keys parseProfile reads:
 * agent/engine keys are camelCase (as parseProfile expects), budget keys are snake_case (its
 * existing convention). `name` is NOT serialized — it is supplied to parseProfile as an argument.
 */
export function serializeProfile(profile: CliProfile): string {
  const agent: TomlTable = { model: profile.agent.model };
  if (profile.agent.systemPrompt) agent.systemPrompt = profile.agent.systemPrompt;
  if (profile.agent.maxIterations !== undefined) agent.maxIterations = profile.agent.maxIterations;
  const t = profile.agent.tools;
  if (t) {
    const tools: TomlTable = {};
    if (t.enabled !== undefined) tools.enabled = t.enabled;
    if (t.allow) tools.allow = [...t.allow];
    if (t.deny) tools.deny = [...t.deny];
    if (Object.keys(tools).length > 0) agent.tools = tools;
  }
  const engine: TomlTable = {};
  if (profile.engine.gateMode) engine.gateMode = profile.engine.gateMode;
  if (profile.engine.dryRun !== undefined) engine.dryRun = profile.engine.dryRun;
  if (profile.engine.yes !== undefined) engine.yes = profile.engine.yes;
  const p = profile.engine.paths;
  if (p) {
    const paths: TomlTable = {};
    if (p.prometheusPy) paths.prometheusPy = p.prometheusPy;
    if (p.python) paths.python = p.python;
    if (Object.keys(paths).length > 0) engine.paths = paths;
  }
  const table: TomlTable = { agent, engine };
  const b = profile.budget;
  if (b) {
    const budget: TomlTable = {};
    if (b.sessionUsd !== undefined) budget.session_usd = b.sessionUsd;
    if (b.dailyUsd !== undefined) budget.daily_usd = b.dailyUsd;
    if (b.warnAtPercent !== undefined) budget.warn_at_percent = b.warnAtPercent;
    if (Object.keys(budget).length > 0) table.budget = budget;
  }
  return stringifyToml(table);
}

/** Parse a model ref string: "ollama:qwen3:8b" → {ollama, qwen3:8b}; "claude-opus" → cloud. */
export function parseModelRef(model: string): ModelRef {
  const i = model.indexOf(":");
  if (i > 0) {
    return { provider: model.slice(0, i), modelId: model.slice(i + 1) };
  }
  return { provider: "anthropic", modelId: model };
}

/** CLI flags that override a profile's engine defaults (flags win, §6). */
export interface ProfileFlagOverrides {
  gateMode?: "enforce" | "warn" | "off";
  dryRun?: boolean;
  yes?: boolean;
  model?: string;
}

/** Merge CLI flags on top of a profile — flags win (§6). */
export function mergeFlags(profile: CliProfile, flags: ProfileFlagOverrides): CliProfile {
  return {
    ...profile,
    agent: { ...profile.agent, ...(flags.model ? { model: flags.model } : {}) },
    engine: {
      ...profile.engine,
      ...(flags.gateMode ? { gateMode: flags.gateMode } : {}),
      ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun } : {}),
      ...(flags.yes !== undefined ? { yes: flags.yes } : {}),
    },
  };
}

/**
 * Merge three profile layers with precedence project > user > builtin (CLI-046). SCALAR-REPLACE
 * per key — a defined project value REPLACES the user/builtin one wholesale (arrays like tool
 * allow/deny are never concatenated across layers, so a repo pinning tools doesn't inherit stray
 * user entries). Only `builtin` is required (it always carries agent.model). PURE.
 */
export function resolveEffectiveProfile(layers: {
  builtin: CliProfile;
  user?: CliProfile;
  project?: CliProfile;
}): CliProfile {
  const { builtin, user, project } = layers;
  const pick = <T>(...vals: (T | undefined)[]): T | undefined => vals.find((v) => v !== undefined);
  // order = project, user, builtin (first defined wins).
  const model =
    pick(project?.agent.model, user?.agent.model, builtin.agent.model) ?? builtin.agent.model;
  const systemPrompt = pick(
    project?.agent.systemPrompt,
    user?.agent.systemPrompt,
    builtin.agent.systemPrompt,
  );
  const tools = pick(project?.agent.tools, user?.agent.tools, builtin.agent.tools);
  const maxIterations = pick(
    project?.agent.maxIterations,
    user?.agent.maxIterations,
    builtin.agent.maxIterations,
  );
  const gateMode = pick(project?.engine.gateMode, user?.engine.gateMode, builtin.engine.gateMode);
  const dryRun = pick(project?.engine.dryRun, user?.engine.dryRun, builtin.engine.dryRun);
  const yes = pick(project?.engine.yes, user?.engine.yes, builtin.engine.yes);
  const paths = pick(project?.engine.paths, user?.engine.paths, builtin.engine.paths);
  const budget = pick(project?.budget, user?.budget, builtin.budget);
  return {
    agent: {
      model,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(tools ? { tools } : {}),
    },
    engine: {
      ...(gateMode ? { gateMode } : {}),
      ...(dryRun !== undefined ? { dryRun } : {}),
      ...(yes !== undefined ? { yes } : {}),
      ...(paths ? { paths } : {}),
    },
    ...(budget ? { budget } : {}),
  };
}

/** Map a profile → the universal AgentTuning the loop consumes (allow [] = all tools). */
export function resolveTuning(profile: CliProfile): AgentTuning {
  // agent.maxIterations → maxRounds (CLI-072). A configured value < 1 means "use the default"
  // (never 0/negative → the agent would be bricked, capping before the first round).
  const mi = profile.agent.maxIterations;
  const maxRounds =
    typeof mi === "number" && Number.isFinite(mi) && mi >= 1 ? Math.floor(mi) : undefined;
  return {
    model: parseModelRef(profile.agent.model),
    systemPrompt: profile.agent.systemPrompt ?? DEFAULT_SYSTEM,
    tools: {
      enabled: profile.agent.tools?.enabled ?? true,
      allow: profile.agent.tools?.allow ?? [],
      deny: profile.agent.tools?.deny ?? [],
    },
    gateMode: profile.engine.gateMode ?? "enforce",
    dryRun: profile.engine.dryRun ?? false,
    verbosity: "normal",
    yes: profile.engine.yes ?? false,
    ...(maxRounds !== undefined ? { maxRounds } : {}),
  };
}
