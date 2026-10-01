// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * resolve-path.ts — repair PATH for a GUI-launched (Finder/Dock) desktop app.
 *
 * THE BUG THIS FIXES: an Electron app launched from Finder/Dock/Spotlight (not a
 * terminal) inherits macOS's minimal launchd PATH — `/usr/bin:/bin:/usr/sbin:/sbin`
 * — which OMITS Homebrew (`/opt/homebrew/bin`), `~/.local/bin`, LM Studio, opencode,
 * and every other user tool dir. Prometheus's install/detect work runs in the python
 * engine + sidecars, which shell out to `git` / `claude` / `ollama` / `hf` / `brew`.
 * With the stripped PATH those binaries are NOT FOUND, so every install fails and host
 * detection (e.g. `which ollama`) reports false-negatives even when the tool IS
 * installed. `safeChildEnv` (engine-bridge) forwards `process.env.PATH` verbatim to
 * every child, so repairing it HERE (once, before any spawn) fixes the whole chain:
 * installs, catalog/model detection, and the Environments panel's tool probing.
 *
 * PURE by design: this module does NOT spawn a child process. Per C5 (biome
 * noRestrictedImports) only `@prometheus/engine-bridge` may import `node:child_process`
 * — so we do NOT resolve the login-shell PATH here. Instead we union the current PATH
 * with the well-known tool dirs that actually EXIST on disk. That covers every standard
 * install location (Homebrew, ~/.local/bin, LM Studio, opencode, cargo/deno/bun,
 * pyenv/nvm shims, conda). If a user keeps a tool in a truly non-standard dir, the
 * engine-bridge's own detection remains the deeper authority. No-op on Windows.
 */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";

/**
 * Well-known user/tool bin dirs that a GUI-launch PATH tends to miss. Ordered so the
 * user-preferred managers (Homebrew, ~/.local) win over system dirs. Only those that
 * exist on disk are added (see computeRepairedPath).
 */
export function wellKnownDirs(home: string = homedir()): string[] {
  return [
    // Homebrew (Apple Silicon + Intel)
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    // user-local + language/runtime managers
    `${home}/.local/bin`,
    `${home}/bin`,
    `${home}/.lmstudio/bin`,
    `${home}/.opencode/bin`,
    `${home}/.cargo/bin`,
    `${home}/.deno/bin`,
    `${home}/.bun/bin`,
    `${home}/go/bin`,
    // python/node version managers (shims dir is what needs to be on PATH)
    `${home}/.pyenv/shims`,
    `${home}/.pyenv/bin`,
    `${home}/.nvm/current/bin`,
    `${home}/.rbenv/shims`,
    // conda/mamba (base env)
    `${home}/miniconda3/bin`,
    `${home}/anaconda3/bin`,
    `${home}/miniforge3/bin`,
    // system fallbacks
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

/**
 * Compute the repaired PATH string (pure — does not mutate env). Callers may inject the
 * current PATH, an fs existence check, and home dir so this is fully unit-testable.
 * De-duplicated, order-preserving: existing PATH entries are kept first (never dropped),
 * then well-known dirs that exist on disk are appended if not already present.
 */
export function computeRepairedPath(opts?: {
  currentPath?: string;
  exists?: (p: string) => boolean;
  home?: string;
}): string {
  const currentPath = opts?.currentPath ?? process.env.PATH ?? "";
  const exists = opts?.exists ?? existsSync;
  const home = opts?.home ?? homedir();

  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const p = raw.trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  };

  // 1. keep everything already on PATH (never lose an entry).
  for (const p of currentPath.split(":")) add(p);
  // 2. append well-known tool dirs that actually exist on disk.
  for (const p of wellKnownDirs(home)) if (exists(p)) add(p);

  return parts.join(":");
}

/**
 * Repair `process.env.PATH` in place. Call ONCE, as early as possible in the main
 * process, before creating the engine client / registering handlers / any spawn.
 * No-op on Windows (its GUI PATH inheritance already includes user dirs). Returns the
 * PATH now in effect.
 */
export function repairPath(): string {
  if (platform() === "win32") return process.env.PATH ?? "";
  const merged = computeRepairedPath();
  if (merged) process.env.PATH = merged;
  return process.env.PATH ?? "";
}
