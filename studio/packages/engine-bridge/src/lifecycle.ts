// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * lifecycle.ts — the STATE-CHANGING catalog surface (file 06 §4.2 / §8).
 *
 * install / uninstall / enable / disable / bundle / sync / scaffoldSkill +
 * apps/worldsim/models lifecycle actions. Every method is a typed argv builder over the
 * EXISTING `runPrometheus` (engine-bridge is the ONLY JS->engine gateway — C5). It does
 * NOT re-use the bare EngineClient.install/uninstall/enable/disable (those exist but omit
 * the surgical `--host`/`--skip`/`--arm`/`--component` surface file 06 needs) — it builds
 * the FULL argv the engine's argparse accepts, ground-truthed against prometheus.py:10431+.
 *
 * THE GOLDEN RULE (C5): nothing here decides "safe". install() does NOT pre-judge — it
 * forwards to the engine, which runs nemesis ITSELF (prepare_nemesis → enforce_gate on
 * each git_clone target) and returns an `ok:false` / `forced_danger` envelope when blocked.
 * A blocked install is a VALID returned envelope the GUI renders (the deep-red banner) —
 * it is NEVER thrown as success and NEVER upgraded toward "allow".
 *
 * Defaults match the engine + the MCP server (file 06 §8): `dryRun:true`, `yes:false`,
 * `force:false`. The bridge REFUSES to pass `force` unless the caller explicitly sets it
 * (the deep-red typed-confirm is captured upstream by file 03's flow); `force` is only
 * emitted as the engine global `--force` flag when `force:true` is passed in.
 *
 * CONTRACT (C2): GLOBAL flags (`--dry-run`, `--yes`, `--strict`, `--force`) come BEFORE
 * the subcommand. The run layer prepends `--json --no-color`; these builders return the
 * line that follows those, i.e. `[...globalFlags, subcommand, ...positionals/flags]`.
 */
import type { EngineConfig } from "./config.js";
import { type EngineEnvelope, type RunOptions, runPrometheus } from "./run.js";
import type { InstallEnvelope } from "./types/install.js";

// ── option bags (ground-truthed against prometheus.py argparse) ───────────────

export interface LifecycleClientOptions {
  config?: EngineConfig;
  timeoutMs?: number;
  cwd?: string;
}

/** `install <name>` flags (`p_inst` :10434). `name` may be the `plugin:comp1,comp2` form. */
export interface InstallOptions extends RunOptions {
  /** restrict to detected agents (repeatable `--host`): claude, codex, cursor, gemini. */
  host?: string | string[];
  /** install ONLY these components (comma-sep sub-plugin ids) → `--only`. */
  only?: string;
  /** install all components EXCEPT these (comma-sep) → `--skip`. */
  skip?: string;
  /** auto-arm: write enabledPlugins + extraKnownMarketplaces so it self-fires → `--arm`. */
  arm?: boolean;
  /** preview the plan + verdict, change nothing (GLOBAL `--dry-run`). DEFAULT true. */
  dryRun?: boolean;
  /** non-interactive accept (GLOBAL `--yes`). DEFAULT false. */
  yes?: boolean;
  /** treat MEDIUM findings as block-worthy too (GLOBAL `--strict`). */
  strict?: boolean;
  /** override a nemesis BLOCK → forced_danger (GLOBAL `--force`). DEFAULT false. */
  force?: boolean;
}

/** `uninstall <name>` flags (`p_unin` :10441). */
export interface UninstallOptions extends RunOptions {
  host?: string | string[];
  only?: string;
  skip?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/** `enable`/`disable` flags (`p_en`/`p_dis` :10449/:10454). */
export interface ToggleOptions extends RunOptions {
  only?: string;
  /** toggle the plugin's on-disk hooks or MCP servers rather than the whole plugin. */
  component?: "hooks" | "mcp";
  host?: string | string[];
}

/** `bundle` flags (`p_bndl` :10431) — only `--host`. */
export interface BundleOptions extends RunOptions {
  host?: string | string[];
}

/** `scaffold-skill <name>` flags (`p_scaf` :10467). */
export interface ScaffoldSkillOptions extends RunOptions {
  /** the TRIGGER — write as "Use when …" (sharper = more reliable auto-fire). */
  trigger?: string;
  /** the instructions the agent follows when the skill fires. */
  body?: string;
  /** allowed-tools auto-granted while active (e.g. "Read Edit"). */
  tools?: string;
  /** disable model invocation (manual /name only) → `--manual`. */
  autoFire?: boolean;
}

/** apps/worldsim/models actions share `{path?, version?}` (file 06 §4.4). */
export interface AppActionOptions extends RunOptions {
  path?: string;
  version?: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** `--host A --host B` (repeatable), from a string or string[]. */
function hostFlags(host?: string | string[]): string[] {
  if (!host) return [];
  const hosts = Array.isArray(host) ? host : [host];
  return hosts.flatMap((h) => ["--host", h]);
}

// ── the client ────────────────────────────────────────────────────────────────

/**
 * The state-changing catalog client. Every gated mutation routes through the engine's
 * own nemesis gate; this layer only marshals argv + returns the engine's envelope.
 */
export class LifecycleClient {
  private readonly opts: LifecycleClientOptions;

  constructor(opts: LifecycleClientOptions = {}) {
    this.opts = opts;
  }

  private run<T extends EngineEnvelope = EngineEnvelope>(
    argv: string[],
    extra?: RunOptions,
  ): Promise<T> {
    return runPrometheus<T>(
      argv,
      { timeoutMs: this.opts.timeoutMs, cwd: this.opts.cwd, ...extra },
      this.opts.config ?? {},
    );
  }

  /**
   * `install <name>` — the gated install (`cmd_install`). Defaults `dryRun:true` so the
   * FIRST call is always a preview + verdict (the GUI renders it, then re-calls with
   * `dryRun:false, yes:true` only after the human OK). `force` is emitted ONLY when
   * explicitly passed true. The engine runs nemesis; a BLOCK returns `ok:false` +
   * `forced_danger` (when forced) — a value, never a throw (C5).
   */
  install(name: string, opts: InstallOptions = {}): Promise<InstallEnvelope> {
    const dryRun = opts.dryRun ?? true; // default = preview first (file 06 §8 / MCP)
    const argv = [
      ...(dryRun ? ["--dry-run"] : []),
      ...(opts.yes ? ["--yes"] : []),
      ...(opts.strict ? ["--strict"] : []),
      ...(opts.force ? ["--force"] : []),
      "install",
      name,
      ...hostFlags(opts.host),
      ...(opts.only ? ["--only", opts.only] : []),
      ...(opts.skip ? ["--skip", opts.skip] : []),
      ...(opts.arm ? ["--arm"] : []),
    ];
    return this.run<InstallEnvelope>(argv, { forced: opts.force, ...opts });
  }

  /** `uninstall <name>` (+`--host`/`--only`/`--skip`) (`cmd_uninstall`). Defaults dryRun:true. */
  uninstall(name: string, opts: UninstallOptions = {}): Promise<InstallEnvelope> {
    const dryRun = opts.dryRun ?? true;
    const argv = [
      ...(dryRun ? ["--dry-run"] : []),
      ...(opts.yes ? ["--yes"] : []),
      "uninstall",
      name,
      ...hostFlags(opts.host),
      ...(opts.only ? ["--only", opts.only] : []),
      ...(opts.skip ? ["--skip", opts.skip] : []),
    ];
    return this.run<InstallEnvelope>(argv, opts);
  }

  /** `enable <name>` (+`--only`/`--component hooks|mcp`/`--host`) (`cmd_enable`). */
  enable(name: string, opts: ToggleOptions = {}): Promise<EngineEnvelope> {
    const argv = [
      "enable",
      name,
      ...(opts.only ? ["--only", opts.only] : []),
      ...(opts.component ? ["--component", opts.component] : []),
      ...hostFlags(opts.host),
    ];
    return this.run(argv, opts);
  }

  /** `disable <name>` (reversible; same flags as enable) (`cmd_disable`). */
  disable(name: string, opts: ToggleOptions = {}): Promise<EngineEnvelope> {
    const argv = [
      "disable",
      name,
      ...(opts.only ? ["--only", opts.only] : []),
      ...(opts.component ? ["--component", opts.component] : []),
      ...hostFlags(opts.host),
    ];
    return this.run(argv, opts);
  }

  /**
   * `bundle` — install the official Anthropic bundle in one run (`cmd_bundle`). Equivalent
   * to `install official-bundle`; the engine gates each target the same way. `--host`
   * restricts to detected agents.
   */
  bundle(opts: BundleOptions = {}): Promise<InstallEnvelope> {
    return this.run<InstallEnvelope>(["bundle", ...hostFlags(opts.host)], opts);
  }

  /** `sync <skill> --to <agent>` — replicate a SKILL.md cross-CLI (`cmd_sync`). */
  sync(skill: string, opts: { to?: string } & RunOptions = {}): Promise<EngineEnvelope> {
    const { to, ...run } = opts;
    return this.run(["sync", skill, ...(to ? ["--to", to] : [])], run);
  }

  /**
   * `scaffold-skill <name>` — write an auto-firing SKILL.md (`cmd_scaffold`). `autoFire`
   * defaults true (model-invocable); `autoFire:false` emits `--manual` (manual /name only).
   */
  scaffoldSkill(name: string, opts: ScaffoldSkillOptions = {}): Promise<EngineEnvelope> {
    const autoFire = opts.autoFire ?? true;
    const argv = [
      "scaffold-skill",
      name,
      ...(opts.trigger ? ["--description", opts.trigger] : []),
      ...(opts.body ? ["--body", opts.body] : []),
      ...(opts.tools ? ["--tools", opts.tools] : []),
      ...(autoFire ? [] : ["--manual"]),
    ];
    return this.run(argv, opts);
  }

  /**
   * `apps <action> <tool> [--path] [--version]` (4th fn, `cmd_apps`). The full lifecycle
   * verb set: install/uninstall/update/update-all/enable/disable/restart/rollback. The
   * engine gates the git-clone/compose fetch through nemesis itself (C5). Returns the
   * engine envelope when JSON, else a base envelope with the human stdout echoed by run.ts.
   */
  apps(action: string, tool?: string, opts: AppActionOptions = {}): Promise<EngineEnvelope> {
    const argv = [
      "apps",
      action,
      ...(tool ? [tool] : []),
      ...(opts.path ? ["--path", opts.path] : []),
      ...(opts.version ? ["--version", opts.version] : []),
    ];
    return this.run(argv, opts);
  }

  /** `worldsim <action> <tool> [--path] [--version]` (8th fn, `cmd_worldsim`). */
  worldsim(action: string, tool?: string, opts: AppActionOptions = {}): Promise<EngineEnvelope> {
    const argv = [
      "worldsim",
      action,
      ...(tool ? [tool] : []),
      ...(opts.path ? ["--path", opts.path] : []),
      ...(opts.version ? ["--version", opts.version] : []),
    ];
    return this.run(argv, opts);
  }

  /**
   * `models <action> <tool>` (3rd fn, `cmd_models`). We DRIVE install/lifecycle; serving +
   * VRAM fit-scoring + download progress are handed to file 05's Model Hub. The engine
   * gates the fetch through nemesis itself (C5).
   */
  models(action: string, tool?: string, opts: RunOptions = {}): Promise<EngineEnvelope> {
    return this.run(["models", action, ...(tool ? [tool] : [])], opts);
  }
}

// ── module-level convenience (mirrors env.ts / modelhub) ──────────────────────

const defaultClient = new LifecycleClient();

export const createLifecycleClient = (opts?: LifecycleClientOptions): LifecycleClient =>
  new LifecycleClient(opts);

export const install = (name: string, opts?: InstallOptions): Promise<InstallEnvelope> =>
  defaultClient.install(name, opts);
export const uninstall = (name: string, opts?: UninstallOptions): Promise<InstallEnvelope> =>
  defaultClient.uninstall(name, opts);
export const enable = (name: string, opts?: ToggleOptions): Promise<EngineEnvelope> =>
  defaultClient.enable(name, opts);
export const disable = (name: string, opts?: ToggleOptions): Promise<EngineEnvelope> =>
  defaultClient.disable(name, opts);
export const bundle = (opts?: BundleOptions): Promise<InstallEnvelope> =>
  defaultClient.bundle(opts);
export const sync = (skill: string, opts?: { to?: string } & RunOptions): Promise<EngineEnvelope> =>
  defaultClient.sync(skill, opts);
export const scaffoldSkill = (name: string, opts?: ScaffoldSkillOptions): Promise<EngineEnvelope> =>
  defaultClient.scaffoldSkill(name, opts);
export const apps = (
  action: string,
  tool?: string,
  opts?: AppActionOptions,
): Promise<EngineEnvelope> => defaultClient.apps(action, tool, opts);
export const worldsim = (
  action: string,
  tool?: string,
  opts?: AppActionOptions,
): Promise<EngineEnvelope> => defaultClient.worldsim(action, tool, opts);
export const models = (action: string, tool?: string, opts?: RunOptions): Promise<EngineEnvelope> =>
  defaultClient.models(action, tool, opts);
