/**
 * main/ide/terminal-menu.ts — the MAIN-side terminal-launcher bridge over @prometheus/core
 * (APP-048). The sandboxed renderer must NOT import core (C5), so the "+ New terminal ▾"
 * menu + per-item resolution cross here: core's `buildProfileMenu`/`resolveProfile` are the
 * SINGLE SOURCE of the shell profiles, AI presets, and env profiles — no renderer constants.
 *
 * Pure (no electron / node:child_process): maps the plain renderer request → core →
 * renderer-safe {items} / {resolved}, so it is node:test-tested directly.
 */
import { type Env, terminal } from "@prometheus/core";

import type {
  IdeTerminalEnv,
  IdeTerminalMenuItem,
  IdeTerminalResolved,
} from "../../shared/ipc-contract.js";

/** Coerce the renderer's plain env rows into core `Env` (for env profiles / venv resolve). */
export function coerceEnvs(raw: readonly IdeTerminalEnv[] | undefined): Env[] {
  if (!raw) return [];
  return raw
    .filter(
      (e) => e && typeof e.path === "string" && e.path && typeof e.name === "string" && e.name,
    )
    .map((e) => ({
      name: e.name,
      path: e.path,
      kind: (e.kind as Env["kind"]) ?? "venv",
      pythonVersion: e.pythonVersion ?? null,
      packagesCount: 0,
    }));
}

/** A clean, runnable install command from a core preset's install HINT ("npm i … — or …"). */
function cleanInstall(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const cmd = hint.split(" — ")[0]?.trim();
  // reject an embedded newline (a multi-line hint would auto-execute when primed).
  return cmd && !/[\r\n]/.test(cmd) ? cmd : undefined;
}

/** Build the renderer-safe menu items from core (shells → AI presets → env profiles). */
export function buildTerminalMenuItems(
  envs: readonly IdeTerminalEnv[] | undefined,
): IdeTerminalMenuItem[] {
  const menu = terminal.buildProfileMenu(coerceEnvs(envs));
  const items: IdeTerminalMenuItem[] = [];
  for (const p of menu.shells) {
    items.push({ id: p.id, title: p.title, kind: "shell" });
  }
  for (const p of menu.aiPresets) {
    const item: IdeTerminalMenuItem = { id: p.id, title: p.title, kind: "ai-preset" };
    if (p.detect?.bin) item.detectBin = p.detect.bin;
    const install = cleanInstall(p.detect?.install);
    if (install) item.install = install;
    items.push(item);
  }
  for (const p of menu.envProfiles) {
    items.push({ id: p.id, title: p.title, subtitle: "env", kind: "env" });
  }
  return items;
}

/** All resolvable profiles (builtins + env profiles) keyed by id. */
function profileById(
  id: string,
  envs: readonly IdeTerminalEnv[] | undefined,
): terminal.TerminalProfile | undefined {
  const menu = terminal.buildProfileMenu(coerceEnvs(envs));
  return (
    menu.shells.find((p) => p.id === id) ??
    menu.aiPresets.find((p) => p.id === id) ??
    menu.envProfiles.find((p) => p.id === id)
  );
}

export interface ResolveCtxInput {
  workspaceRoot: string;
  home: string;
  platform: "posix" | "win32";
  envs?: readonly IdeTerminalEnv[];
  activeEnvPath?: string | null;
  fileDir?: string;
}

/** Resolve one menu item id into a renderer-safe launch (or undefined for an unknown id). */
export function resolveTerminalItem(
  id: string,
  ctx: ResolveCtxInput,
): IdeTerminalResolved | undefined {
  const profile = profileById(id, ctx.envs);
  if (!profile) return undefined;
  const coreCtx: terminal.ResolveContext = {
    projectRoot: ctx.workspaceRoot,
    home: ctx.home,
    platform: ctx.platform,
    envs: coerceEnvs(ctx.envs),
    activeEnvPath: ctx.activeEnvPath ?? null,
    ...(ctx.fileDir ? { fileDir: ctx.fileDir } : {}),
  };
  const spawn = terminal.resolveProfile(profile, coreCtx);
  const isAi = terminal.isAiPreset(profile);
  const group: IdeTerminalResolved["group"] = isAi
    ? "ai"
    : profile.managedBy === "env"
      ? "project"
      : "project";
  const out: IdeTerminalResolved = {
    cwd: spawn.args.cwd,
    title: profile.title,
    kind: isAi ? "ai-preset" : profile.managedBy === "env" ? "env" : "shell",
    group,
    venv: spawn.args.venv,
  };
  if (spawn.args.shell) out.shell = spawn.args.shell;
  if (spawn.ai) {
    // strip an embedded newline so a primed multi-line command can't auto-execute.
    out.launch = spawn.ai.command.replace(/[\r\n]+/g, " ").trim();
    out.autorun = spawn.ai.autorun;
  }
  return out;
}
