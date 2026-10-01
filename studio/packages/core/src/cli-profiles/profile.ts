// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * cli-profiles/profile.ts — the CLI profile schema + resolve/merge (file 11 §6).
 *
 * A profile bundles agent tuning + engine defaults so a context switches in one
 * keystroke. Stored as TOML, SHARED with the GUI (same files/schema). Resolution:
 * flags > profile > built-in default. `resolveTuning` maps a profile's [agent]
 * section → the universal AgentTuning the loop consumes. PURE.
 */
import type { AgentTuning } from "../agent/loop.js";
import { APPLY_PATCH_TOOL } from "../agent/patch.js";
import { QUESTION_TOOL } from "../agent/question.js";
import { WEB_SEARCH_TOOL } from "../agent/search.js";
import { SPAWN_AGENT_TOOL } from "../agent/subagent.js";
import { SYSTEM_FS_WRITE_TOOLS } from "../agent/system/fs-mutate.js";
import { SYSTEM_MEMORY_TOOLS } from "../agent/system/memory.js";
import { SYSTEM_TOOLS } from "../agent/system/tools.js";
import { TODO_TOOLS } from "../agent/todo.js";
import type { ModelRef } from "../agents/types.js";
import type { EffortTier } from "../ai/effort/types.js";
import { isEffortTier } from "../ai/effort/types.js";
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
    /**
     * The reasoning-effort tier this project/user starts at — the `/think` ladder, pinned.
     *
     * Maps to `AgentTuning.effort`. Absent ⇒ the session starts unset, which is NOT the same
     * as `"off"`: unset means "no tier was chosen", and the composer badge reads the model's
     * own default rather than claiming one.
     */
    effort?: EffortTier;
    /**
     * Send the effort knob even when `ai/effort/rules.ts` says this model has none.
     *
     * OFF by default and deliberately awkward to reach, because it re-opens exactly the
     * failure that module exists to close: a forwarded `reasoning_effort` is a hard 400 on a
     * GPT-4-class model. It exists for the model released after these rules were written.
     */
    effortForce?: boolean;
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
    /**
     * What a USD cap does when a model has NO price entry: `"block"` (the default) or
     * `"warn"`. Thirteen of the eighteen cloud providers are unpriced, and an unpriced record
     * used to count as $0 — so the cap silently did not apply to them. `"warn"` is the
     * explicit opt-in to spend uncapped on those models.
     */
    unpricedPolicy?: "block" | "warn";
  };
}

/**
 * `DEFAULT_SYSTEM` (and any profile's own `agent.systemPrompt`) is the PERSONA layer only —
 * "who Prometheus is". Behavioral instructions (tool-discipline, the pre-write recheck,
 * effort-as-text, steering/memory/repo-map) are no longer this function's job: they are added
 * on top, once per turn, by the preamble dispatch pipeline in
 * `apps/cli/src/session/agent-runtime.ts`'s `runMessageTurn`. `resolveTuning` stays PURE and
 * profile-only on purpose; it has no endpoint, no effort capability, no transport to build a
 * `PreambleCtx` from.
 */
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
  // `[agent] effort` — validated against the ladder, because a typo'd tier that silently
  // became "unset" would look identical to not configuring one at all.
  const effortRaw = str(agentT?.effort);
  const effort = isEffortTier(effortRaw) ? effortRaw : undefined;
  const effortForce = bool(agentT?.effortForce);
  const engineT = asTable(doc.engine);
  const pathsT = asTable(engineT?.paths);
  const gateMode = str(engineT?.gateMode);
  const budgetT = asTable(doc.budget);
  // TOML keys are snake_case (session_usd) — mirror the file's existing convention.
  const sessionUsd = num(budgetT?.session_usd);
  const dailyUsd = num(budgetT?.daily_usd);
  const warnAtPercent = num(budgetT?.warn_at_percent);
  // Only the literal "warn" stands the fail-closed default down: a typo must not disable a cap.
  const unpricedPolicy = str(budgetT?.unpriced_policy) === "warn" ? ("warn" as const) : undefined;
  const budget =
    sessionUsd !== undefined ||
    dailyUsd !== undefined ||
    warnAtPercent !== undefined ||
    unpricedPolicy !== undefined
      ? {
          ...(sessionUsd !== undefined ? { sessionUsd } : {}),
          ...(dailyUsd !== undefined ? { dailyUsd } : {}),
          ...(warnAtPercent !== undefined ? { warnAtPercent } : {}),
          ...(unpricedPolicy !== undefined ? { unpricedPolicy } : {}),
        }
      : undefined;
  const profile: CliProfile = {
    ...(name ? { name } : {}),
    agent: {
      model,
      ...(str(agentT?.systemPrompt) ? { systemPrompt: str(agentT?.systemPrompt) } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(effortForce !== undefined ? { effortForce } : {}),
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
  if (profile.agent.effort !== undefined) agent.effort = profile.agent.effort;
  if (profile.agent.effortForce !== undefined) agent.effortForce = profile.agent.effortForce;
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
  /** `--effort <tier>` — the human at the keyboard outranks every config layer (§6). */
  effort?: EffortTier;
  /** `--force-effort` — send the knob over the capability table's objection. */
  effortForce?: boolean;
}

/** Merge CLI flags on top of a profile — flags win (§6). */
export function mergeFlags(profile: CliProfile, flags: ProfileFlagOverrides): CliProfile {
  return {
    ...profile,
    agent: {
      ...profile.agent,
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags.effort ? { effort: flags.effort } : {}),
      ...(flags.effortForce !== undefined ? { effortForce: flags.effortForce } : {}),
    },
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
 * per key — a defined project value REPLACES the user/builtin one wholesale, so a repo pinning
 * a model or a system prompt doesn't inherit stray user entries. Only `builtin` is required (it
 * always carries agent.model). PURE.
 *
 * TWO DELIBERATE EXCEPTIONS, both about the project layer being untrusted (see
 * `sanitizeProjectLayer`): `tools.deny` ACCUMULATES across layers and `tools.allow` INTERSECTS.
 * Wholesale replacement was right for a preference and wrong for a safety decision — under it, a
 * user who denied `run_command` had it re-armed by any repo whose config happened to deny
 * something else.
 */
/** The gate postures, ordered by how much they protect. Higher = stricter. */
const GATE_RANK: Readonly<Record<"off" | "warn" | "enforce", number>> = Object.freeze({
  off: 0,
  warn: 1,
  enforce: 2,
});

/** One setting a project file asked for and did not get, and why. Shown to the user. */
export interface ProjectLayerRejection {
  key: string;
  reason: string;
}

/**
 * Strip anything from the project layer that would WEAKEN the user's safety posture.
 *
 * A `.prometheus.toml` is discovered by walking UPWARD from the working directory, so it
 * arrives with the code: cloning a repository and running `prometheus` inside it is enough to
 * apply it. It was the highest-priority layer for every key, which meant a checked-in file
 * could set `gateMode = "off"` and silently disable the nemesis scan for anyone who visited
 * that directory. That is a supply-chain shape, not a configuration preference.
 *
 * So the project layer is TIGHTEN-ONLY on the security keys. It may still do everything a
 * project config is actually for — pin the model, set the system prompt, cap iterations, narrow
 * the tool list, lower a budget — and it may make the posture *stricter* than the user's. It
 * simply cannot make it looser.
 *
 * `base` is builtin ⊕ user: the posture the human running the command chose for themselves.
 * PURE. Returns the filtered layer plus every rejection, because silently ignoring a setting
 * someone wrote is its own kind of dishonesty — the host prints these.
 */
export function sanitizeProjectLayer(
  project: CliProfile,
  base: CliProfile,
): { profile: CliProfile; rejected: ProjectLayerRejection[] } {
  const rejected: ProjectLayerRejection[] = [];
  const engine: CliProfile["engine"] = { ...project.engine };

  // gateMode: may only be raised. off < warn < enforce.
  const pg = project.engine.gateMode;
  const bg = base.engine.gateMode ?? "enforce";
  if (pg && GATE_RANK[pg] < GATE_RANK[bg]) {
    rejected.push({
      key: "engine.gateMode",
      reason: `project asked for "${pg}", weaker than "${bg}" — a project file cannot turn the scanner down`,
    });
    engine.gateMode = undefined;
  }

  // yes: blanket auto-approval. A project may withdraw it, never grant it.
  if (project.engine.yes === true && base.engine.yes !== true) {
    rejected.push({
      key: "engine.yes",
      reason: "a project file cannot auto-approve every tool call on your behalf",
    });
    engine.yes = undefined;
  }

  // dryRun: `true` is the safe direction. A project cannot take a user's dry-run away.
  if (project.engine.dryRun === false && base.engine.dryRun === true) {
    rejected.push({
      key: "engine.dryRun",
      reason: "a project file cannot cancel your dry-run",
    });
    engine.dryRun = undefined;
  }

  // paths: repointing the engine or the interpreter is arbitrary code execution by config.
  // There is no tightening direction here, so the project layer never gets this key at all.
  if (project.engine.paths) {
    rejected.push({
      key: "engine.paths",
      reason: "a project file cannot repoint the engine or interpreter binary",
    });
    engine.paths = undefined;
  }

  // tools: denies UNION across layers (a project may add, never remove); allow INTERSECTS with
  // the user's list when they set one (a project may narrow, never widen).
  let tools = project.agent.tools;
  if (tools || base.agent.tools) {
    const baseDeny = base.agent.tools?.deny ?? [];
    const projDeny = tools?.deny ?? [];
    const deny = [...new Set([...baseDeny, ...projDeny])];
    const dropped = baseDeny.filter((t) => !projDeny.includes(t));
    if (tools && dropped.length > 0) {
      rejected.push({
        key: "agent.tools.deny",
        reason: `kept your denies as well (${dropped.join(", ")}) — a project file cannot re-arm a tool you disabled`,
      });
    }
    const baseAllow = base.agent.tools?.allow ?? [];
    let allow = tools?.allow ?? baseAllow;
    if (tools?.allow && baseAllow.length > 0) {
      const widened = tools.allow.filter((t) => !baseAllow.includes(t));
      allow = tools.allow.filter((t) => baseAllow.includes(t));
      if (widened.length > 0) {
        rejected.push({
          key: "agent.tools.allow",
          reason: `ignored ${widened.join(", ")} — a project file cannot add tools outside your allow-list`,
        });
      }
    }
    const enabled = tools?.enabled ?? base.agent.tools?.enabled;
    tools = {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(allow.length > 0 ? { allow } : {}),
      ...(deny.length > 0 ? { deny } : {}),
    };
  }

  // budget: a cap may only come DOWN. An absent project cap does not lift the user's.
  let budget = project.budget;
  if (budget && base.budget) {
    const lower = (a: number | undefined, b: number | undefined): number | undefined =>
      a === undefined ? b : b === undefined ? a : Math.min(a, b);
    budget = {
      ...(lower(budget.sessionUsd, base.budget.sessionUsd) !== undefined
        ? { sessionUsd: lower(budget.sessionUsd, base.budget.sessionUsd) as number }
        : {}),
      ...(lower(budget.dailyUsd, base.budget.dailyUsd) !== undefined
        ? { dailyUsd: lower(budget.dailyUsd, base.budget.dailyUsd) as number }
        : {}),
      ...(lower(budget.warnAtPercent, base.budget.warnAtPercent) !== undefined
        ? { warnAtPercent: lower(budget.warnAtPercent, base.budget.warnAtPercent) as number }
        : {}),
    };
  }

  return {
    profile: {
      ...project,
      agent: { ...project.agent, ...(tools ? { tools } : {}) },
      engine,
      ...(budget ? { budget } : {}),
    },
    rejected,
  };
}

/**
 * The same resolution as `resolveEffectiveProfile`, plus what the project layer was refused.
 *
 * Split out so a host can TELL the user. A setting that is silently dropped teaches them the
 * file works when it does not.
 */
export function resolveEffectiveProfileWithNotes(layers: {
  builtin: CliProfile;
  user?: CliProfile;
  project?: CliProfile;
}): { profile: CliProfile; rejected: ProjectLayerRejection[] } {
  const { builtin, user, project } = layers;
  if (!project)
    return { profile: mergeLayers({ builtin, ...(user ? { user } : {}) }), rejected: [] };
  // The posture the human chose for themselves, before the repo gets a say.
  const base = mergeLayers({ builtin, ...(user ? { user } : {}) });
  const { profile: safeProject, rejected } = sanitizeProjectLayer(project, base);
  return {
    profile: mergeLayers({ builtin, ...(user ? { user } : {}), project: safeProject }),
    rejected,
  };
}

/**
 * Resolve the effective profile across the three layers.
 *
 * The project layer is SANITIZED first — see `sanitizeProjectLayer`. That happens in here, not
 * in the caller, precisely so a host that forgets cannot reintroduce the hole: there is exactly
 * one way to combine these layers and it is this one. Use `resolveEffectiveProfileWithNotes`
 * when you want to tell the user what the project file was refused.
 */
export function resolveEffectiveProfile(layers: {
  builtin: CliProfile;
  user?: CliProfile;
  project?: CliProfile;
}): CliProfile {
  return resolveEffectiveProfileWithNotes(layers).profile;
}

/** The raw first-defined-wins merge. PRIVATE: it has no idea what a security key is. */
function mergeLayers(layers: {
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
  const effort = pick(project?.agent.effort, user?.agent.effort, builtin.agent.effort);
  // NOT taken from the project layer. `effortForce` re-opens the 400 this table exists to
  // prevent, and `.prometheus.toml` arrives with the code — the same reason the project layer
  // may tighten the safety posture and never loosen it (see `sanitizeProjectLayer`). A repo
  // cannot decide to bypass capability checking on a machine it was merely cloned onto.
  const effortForce = pick(user?.agent.effortForce, builtin.agent.effortForce);
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
      ...(effort !== undefined ? { effort } : {}),
      ...(effortForce !== undefined ? { effortForce } : {}),
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
    // A configured tier has to survive session start, or `[agent] effort = "high"` is a line
    // the file accepts and nothing reads. Omitted (not defaulted) when unset: `undefined` and
    // `"off"` mean different things to the badge and to `/status`.
    ...(profile.agent.effort !== undefined ? { effort: profile.agent.effort } : {}),
    ...(profile.agent.effortForce !== undefined ? { effortForce: profile.agent.effortForce } : {}),
    tools: {
      enabled: profile.agent.tools?.enabled ?? true,
      allow: profile.agent.tools?.allow ?? [],
      deny: profile.agent.tools?.deny ?? [],
      // full_wrapper_compose Phases 1-2: the read-only view of the machine (files, git,
      // hardware) plus `run_command`. HOST-local, hence `extra` rather than the shared
      // catalog — the CLI dispatches them in `session/system-tools.ts` and their
      // `toArgv` throws.
      //
      // Without these the agent cannot read a file or run `git diff`, which is how `/diff`
      // came to end with the model asking the human to paste the diff. `allow`/`deny` apply
      // to them exactly as they do to any other tool.
      // Tier R + run_command, PLUS the Tier-W file mutators (delete/move/mkdir). Without
      // those three the agent could read, search, write and edit a file but not remove or
      // rename one — an ordinary refactor forced it into `run_command`, a shell-shaped
      // detour at a higher permission tier for a structured operation.
      extra: [
        ...SYSTEM_TOOLS,
        ...SYSTEM_FS_WRITE_TOOLS,
        ...SYSTEM_MEMORY_TOOLS,
        ...TODO_TOOLS,
        APPLY_PATCH_TOOL,
        WEB_SEARCH_TOOL,
        SPAWN_AGENT_TOOL,
        QUESTION_TOOL,
      ],
    },
    gateMode: profile.engine.gateMode ?? "enforce",
    dryRun: profile.engine.dryRun ?? false,
    verbosity: "normal",
    yes: profile.engine.yes ?? false,
    ...(maxRounds !== undefined ? { maxRounds } : {}),
  };
}
