/**
 * terminal/resolve.ts — turn a profile into spawn args (file 13 §1.5).
 *
 * The UX side of the [[04]] handshake: resolve a `TerminalProfile`'s `cwd` + venv into
 * a pure `TerminalSpawnArgs` that the renderer hands to 07's `pty:spawn` (which owns
 * the actual PATH/VIRTUAL_ENV injection via its `buildVenvEnv`). We DO NOT build the
 * environment here — we resolve the *intent* (which venv root, which cwd, which shell,
 * which extra env, and, for AI presets, the launch command). A terminal with a venv is
 * "born activated": no manual `source .venv/bin/activate` (§1.5).
 *
 * Pure + dependency-free: the project root / home / active env are passed IN
 * (ResolveContext), never read from the process — so resolution is deterministic.
 */
import type { Env } from "../domain/models.js";
import type { AiTerminalPreset, CwdSpec, TerminalProfile } from "./profiles.js";
import { isAiPreset } from "./profiles.js";

/** The host platform (decides bin/ vs Scripts\ in 07's buildVenvEnv). */
export type TerminalPlatform = "posix" | "win32";

/** Everything resolution needs, passed in (never read from the env). */
export interface ResolveContext {
  projectRoot: string;
  home: string;
  platform: TerminalPlatform;
  /** the live [[04]] env list (to resolve envRef / activeVenvRoot). */
  envs?: readonly Env[];
  /** the currently-selected env's path (EnvStoreState.selectedEnvPath). */
  activeEnvPath?: string | null;
  /** dir of the file active in the editor (for cwd.kind:'fileDir'). */
  fileDir?: string;
}

/** A resolved venv to activate — `root` is [[04]] Env.path (§1.5). */
export interface ResolvedVenv {
  root: string;
  platform: TerminalPlatform;
}

/** Pure spawn args; the renderer maps this onto 07's `pty:spawn` request. */
export interface TerminalSpawnArgs {
  cwd: string;
  shell?: string;
  shellArgs?: string[];
  /** the venv to activate, or null for a bare shell. 07's pty-host does the PATH work. */
  venv: ResolvedVenv | null;
  /** profile `env` overrides, merged LAST by the host (profile env wins). */
  env: Record<string, string>;
  /** false ⇒ clean env (only `env` + minimal PATH); default true. */
  inheritProcessEnv: boolean;
}

/** Look up an Env by its path (its id). */
function envByPath(
  envs: readonly Env[] | undefined,
  path: string | null | undefined,
): Env | undefined {
  if (!envs || !path) return undefined;
  return envs.find((e) => e.path === path);
}

/** Resolve a CwdSpec to an absolute path against the context (§1.3). */
export function resolveCwd(spec: CwdSpec, ctx: ResolveContext): string {
  switch (spec.kind) {
    case "projectRoot":
      return ctx.projectRoot;
    case "home":
      return ctx.home;
    case "fixed":
      return spec.path;
    case "fileDir":
      return ctx.fileDir ?? ctx.projectRoot;
    case "activeVenvRoot": {
      const env = envByPath(ctx.envs, ctx.activeEnvPath);
      return env?.path ?? ctx.projectRoot;
    }
  }
}

/** Resolve which venv (if any) a profile activates (§1.5). */
export function resolveVenv(profile: TerminalProfile, ctx: ResolveContext): ResolvedVenv | null {
  const env = profile.envRef
    ? envByPath(ctx.envs, profile.envRef)
    : profile.cwd.kind === "activeVenvRoot"
      ? envByPath(ctx.envs, ctx.activeEnvPath)
      : undefined;
  if (!env || env.kind === "system") return null;
  return { root: env.path, platform: ctx.platform };
}

/** Resolve a profile into pure spawn args for 07's pty-host (§1.5). */
export function spawnArgsFor(profile: TerminalProfile, ctx: ResolveContext): TerminalSpawnArgs {
  const args: TerminalSpawnArgs = {
    cwd: resolveCwd(profile.cwd, ctx),
    venv: resolveVenv(profile, ctx),
    env: { ...(profile.env ?? {}) },
    inheritProcessEnv: profile.inheritProcessEnv !== false,
  };
  if (profile.shell?.path) args.shell = profile.shell.path;
  if (profile.shell?.args) args.shellArgs = [...profile.shell.args];
  return args;
}

/* ── AI-preset launch resolution (§1.4) ────────────────────────────────────── */

/** The command an AI preset auto-runs once its shell is ready (§1.4). */
export interface AiLaunch {
  /** the command line to type at the prompt (with the model hint appended if any). */
  command: string;
  /** type+enter immediately (true) vs just prime the prompt (false). */
  autorun: boolean;
  /** extra env to export so the agent sees the repo (PROM_CWD) — §1.4 workspaceContext. */
  exportEnv: Record<string, string>;
  /** the bin to detect; if missing the preset renders disabled with `installHint`. */
  detectBin?: string;
  installHint?: string;
}

/** Resolve an AI preset's launch command + workspace-context env (§1.4). */
export function aiLaunchFor(preset: AiTerminalPreset, ctx: ResolveContext): AiLaunch {
  const command = preset.modelHint ? `${preset.launch} ${preset.modelHint}` : preset.launch;
  const out: AiLaunch = {
    command,
    autorun: preset.autorun,
    exportEnv: preset.workspaceContext ? { PROM_CWD: ctx.projectRoot } : {},
  };
  if (preset.detect?.bin) out.detectBin = preset.detect.bin;
  if (preset.detect?.install) out.installHint = preset.detect.install;
  return out;
}

/** Whether an AI preset is launchable given the set of bins found on PATH (§1.4). */
export function presetAvailable(
  preset: AiTerminalPreset,
  binsOnPath: ReadonlySet<string>,
): boolean {
  // `prom` always ships with Studio ([[11]] §8); presets with no detect are always available.
  if (preset.cli === "prom" || !preset.detect?.bin) return true;
  return binsOnPath.has(preset.detect.bin);
}

/** Convenience: resolve the full spawn intent for any profile (shell or AI preset). */
export interface ResolvedSpawn {
  args: TerminalSpawnArgs;
  /** present only for AI presets. */
  ai?: AiLaunch;
}

export function resolveProfile(profile: TerminalProfile, ctx: ResolveContext): ResolvedSpawn {
  const args = spawnArgsFor(profile, ctx);
  if (isAiPreset(profile)) {
    const ai = aiLaunchFor(profile, ctx);
    return { args: { ...args, env: { ...args.env, ...ai.exportEnv } }, ai };
  }
  return { args };
}
