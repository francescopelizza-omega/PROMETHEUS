// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * terminal/profiles.ts — the terminal-launcher UX model (file 13 §1.3/§1.4).
 *
 * A `TerminalProfile` is the ONLY way a terminal is born: a named recipe (shell + cwd +
 * env) that file 13's `resolve.ts` turns into a spawn request handed to file 07's
 * `pty-host` (this layer NEVER spawns — 07 owns the engine room, this owns the cockpit).
 * An `AiTerminalPreset` narrows a profile to one that auto-runs an agent CLI ("read in
 * the editor, run prompts in a terminal"). Built-in profiles + the 5 shipped AI presets
 * live here as pure data; the Settings → Tools → Terminal UI edits them (§2), 09 layers
 * them. Secrets are NEVER inline — `env` carries keychain REFS only (§1.7).
 */
import type { Env } from "../domain/models.js";

/** Where a profile's terminal starts (§1.3). */
export type CwdSpec =
  | { kind: "projectRoot" } // the open workspace folder (default)
  | { kind: "home" } // $HOME
  | { kind: "fixed"; path: string } // an absolute path
  | { kind: "activeVenvRoot" } // Env.path of the currently-selected env ([[04]])
  | { kind: "fileDir" }; // dir of the file active in the editor (send-to-terminal flows)

/** Where a profile is stored (09 §7.1 layering). */
export type ProfileScope = "global" | "profile" | "workspace";

/** A named shell-session recipe (§1.3). Spawn is 07's pty-host; this is UX only. */
export interface TerminalProfile {
  id: string; // 'shell.project' | 'shell.system' | 'env.ml' | user uuid
  title: string; // "Project shell" — shown in the menu + tab
  icon?: string; // lucide id; default $ shell, ⬢ env, ◆ AI preset
  kind: "shell" | "ai-preset"; // ai-preset narrows to AiTerminalPreset (§1.4)
  shell?: { path: string; args?: string[] }; // undefined ⇒ OS default shell
  cwd: CwdSpec;
  env?: Record<string, string>; // merged over the base (secrets via keychain ref, §1.7)
  envRef?: string; // [[04]] Env.id (its path) — activate THIS venv (§1.5)
  inheritProcessEnv?: boolean; // default true; false = clean env
  color?: string; // optional tab tint (TOKEN name, not hex — 08)
  persist?: boolean; // restore on restart (§1.7)
  builtin?: boolean; // shipped (read-only; user "duplicates to edit")
  managedBy?: "env"; // auto-generated from an [[04]] Env (refreshed on env-list change)
  scope: ProfileScope;
}

/** Which agent CLI an AI preset launches (§1.4). */
export type AiCli = "prometheus" | "claude" | "codex" | "gemini" | "custom";

/** A profile that auto-runs an agent CLI after the shell starts (§1.4). */
export interface AiTerminalPreset extends TerminalProfile {
  kind: "ai-preset";
  cli: AiCli;
  launch: string; // command auto-run on spawn: 'prometheus chat', 'claude', 'gemini -i'
  detect?: { bin: string; install?: string }; // which/where; missing ⇒ disabled + hint (never auto-install)
  modelHint?: string; // optional served Model-Hub endpoint ([[05]]) e.g. --model ollama:qwen3
  autorun: boolean; // type+enter `launch` immediately vs just prime the prompt
  workspaceContext?: boolean; // export PROM_CWD / start in projectRoot so the agent sees the repo
}

/** True when a profile is an AI preset (type guard). */
export function isAiPreset(p: TerminalProfile): p is AiTerminalPreset {
  return p.kind === "ai-preset";
}

/* ── built-in shell profiles (§1.3) ────────────────────────────────────────── */

/** Project shell — the ★ default: OS shell at the project root, active venv injected. */
export const PROFILE_PROJECT: TerminalProfile = {
  id: "shell.project",
  title: "Project shell",
  icon: "terminal",
  kind: "shell",
  cwd: { kind: "projectRoot" },
  inheritProcessEnv: true,
  persist: true,
  builtin: true,
  scope: "global",
};

/** System shell — $HOME, no venv. */
export const PROFILE_SYSTEM: TerminalProfile = {
  id: "shell.system",
  title: "System shell",
  icon: "terminal",
  kind: "shell",
  cwd: { kind: "home" },
  inheritProcessEnv: true,
  persist: false,
  builtin: true,
  scope: "global",
};

/** Bash (login). */
export const PROFILE_BASH_LOGIN: TerminalProfile = {
  id: "shell.bash-login",
  title: "Bash (login)",
  icon: "terminal",
  kind: "shell",
  shell: { path: "/bin/bash", args: ["-l"] },
  cwd: { kind: "projectRoot" },
  inheritProcessEnv: true,
  persist: false,
  builtin: true,
  scope: "global",
};

/** The shipped built-in shell profiles (★ default first). */
export const BUILTIN_SHELL_PROFILES: readonly TerminalProfile[] = Object.freeze([
  PROFILE_PROJECT,
  PROFILE_SYSTEM,
  PROFILE_BASH_LOGIN,
]);

/** The id of the default profile new terminals use. */
export const DEFAULT_PROFILE_ID = PROFILE_PROJECT.id;

/**
 * One auto-generated `env.<name>` profile per [[04]] Env (§1.3) — "open a terminal
 * already in my `ml` env" in one click. Generated from the live Env list, marked
 * `managedBy:'env'`, and refreshed when 04's env list changes. `system` envs are
 * skipped (no venv to activate). The profile's `envRef` is the Env.path (its id).
 */
export function envProfiles(envs: readonly Env[]): TerminalProfile[] {
  return envs
    .filter((e) => e.kind !== "system")
    .map((e) => ({
      id: `env.${e.name}`,
      title: `Env: ${e.name}${e.pythonVersion ? ` (${e.pythonVersion})` : ""}`,
      icon: "box",
      kind: "shell" as const,
      cwd: { kind: "activeVenvRoot" } as CwdSpec,
      envRef: e.path,
      inheritProcessEnv: true,
      persist: false,
      builtin: false,
      managedBy: "env" as const,
      scope: "workspace" as const,
    }));
}

/* ── shipped AI-CLI presets (§1.4) ─────────────────────────────────────────── */

function aiPreset(
  id: string,
  title: string,
  cli: AiCli,
  launch: string,
  over: Partial<AiTerminalPreset> = {},
): AiTerminalPreset {
  return {
    id,
    title,
    icon: "sparkles",
    kind: "ai-preset",
    cli,
    launch,
    cwd: { kind: "projectRoot" },
    inheritProcessEnv: true,
    autorun: true,
    workspaceContext: true,
    persist: false,
    builtin: true,
    scope: "global",
    ...over,
  };
}

/** prometheus chat ◆ — the in-terminal tunable agent ([[11]] §3). The DEFAULT AI preset. */
export const PRESET_PROM_CHAT = aiPreset(
  "ai.prom-chat",
  "prometheus chat",
  "prometheus",
  "prometheus chat",
);
/** prometheus (one-shot) — bare REPL; same engine bridge, no auto-chat. */
export const PRESET_PROM = aiPreset(
  "ai.prom",
  "prometheus (one-shot)",
  "prometheus",
  "prometheus",
  {
    autorun: false,
  },
);
/** claude — Anthropic CLI if installed; else disabled with an install hint. */
export const PRESET_CLAUDE = aiPreset("ai.claude", "claude", "claude", "claude", {
  detect: { bin: "claude", install: "npm i -g @anthropic-ai/claude-code — or see Marketplace" },
});
/** codex — OpenAI Codex CLI. */
export const PRESET_CODEX = aiPreset("ai.codex", "codex", "codex", "codex", {
  detect: { bin: "codex", install: "npm i -g @openai/codex — or see Marketplace" },
});
/** gemini — Google Gemini CLI, interactive. */
export const PRESET_GEMINI = aiPreset("ai.gemini", "gemini", "gemini", "gemini -i", {
  detect: { bin: "gemini", install: "npm i -g @google/gemini-cli — or see Marketplace" },
});

/** The 5 shipped AI presets (prometheus chat is the default). */
export const BUILTIN_AI_PRESETS: readonly AiTerminalPreset[] = Object.freeze([
  PRESET_PROM_CHAT,
  PRESET_PROM,
  PRESET_CLAUDE,
  PRESET_CODEX,
  PRESET_GEMINI,
]);

/** The id of the default AI preset. */
export const DEFAULT_AI_PRESET_ID = PRESET_PROM_CHAT.id;

/** Create a user "custom…" AI preset from a launch string (Settings → Tools → Terminal). */
export function customAiPreset(
  id: string,
  title: string,
  launch: string,
  bin?: string,
): AiTerminalPreset {
  return aiPreset(id, title, "custom", launch, {
    builtin: false,
    scope: "workspace",
    ...(bin ? { detect: { bin } } : {}),
  });
}

/* ── the "+ New terminal ▾" menu model (§1.2) ──────────────────────────────── */

/** A built profile menu: shell profiles, then AI presets, then env profiles. */
export interface ProfileMenu {
  shells: TerminalProfile[];
  aiPresets: AiTerminalPreset[];
  envProfiles: TerminalProfile[];
}

/** Assemble the "+ New terminal ▾" menu from the builtins + the live Env list (§1.2). */
export function buildProfileMenu(
  envs: readonly Env[] = [],
  userProfiles: readonly TerminalProfile[] = [],
  userPresets: readonly AiTerminalPreset[] = [],
): ProfileMenu {
  return {
    shells: [...BUILTIN_SHELL_PROFILES, ...userProfiles.filter((p) => p.kind === "shell")],
    aiPresets: [...BUILTIN_AI_PRESETS, ...userPresets],
    envProfiles: envProfiles(envs),
  };
}
