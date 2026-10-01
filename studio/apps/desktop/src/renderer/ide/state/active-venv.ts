// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * state/active-venv.ts — which environment a new terminal inherits (§6.1).
 *
 * pty-host's header calls venv inheritance "THE LOAD-BEARING BEHAVIOUR" of §6.1: a new terminal
 * comes up as `(.venv) $` so `python` and `pip install` reach the project env without a manual
 * activate. Every part of that path existed — `buildVenvEnv`, the `ptySpawn` venv field, the
 * validator, the store slice — except a WRITER: `setVenv` had zero callers app-wide, so the store
 * value stayed null forever and `Terminal.tsx`'s only fallback for a session with no explicit
 * venv resolved to nothing. The ★ default "Project shell" profile carries no `envRef`, so it
 * depends on precisely that fallback.
 *
 * The rule is kept here, pure, because the component that runs it is a .tsx the node:test harness
 * cannot load (the desktop tsconfig is `noEmit`, and JSX cannot be type-stripped).
 */

/** The minimal env shape this rule needs (a subset of `IdeTerminalEnv`). */
export interface VenvCandidate {
  name: string;
  path: string;
}

/** Normalise away a trailing separator so `/x/.venv/` and `/x/.venv` compare equal. */
function trimEnd(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/**
 * Pick the environment a terminal opened in `workspaceRoot` should inherit, or null.
 *
 * ONLY an env that lives inside the workspace qualifies: an env registered elsewhere on the
 * machine belongs to a different project, and force-activating it in this project's terminals
 * would be worse than activating nothing. Among those inside, a conventional `.venv` wins over an
 * arbitrarily named one so the common layout is predictable.
 */
export function pickActiveVenv(
  workspaceRoot: string,
  envs: readonly VenvCandidate[],
): { root: string } | null {
  const root = trimEnd(workspaceRoot);
  if (!root) return null;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const inside = envs.filter((e) => {
    const p = trimEnd(e.path);
    return p !== "" && p !== root && p.startsWith(`${root}${sep}`);
  });
  if (inside.length === 0) return null;
  const dotVenv = inside.find((e) => trimEnd(e.path).endsWith(`${sep}.venv`));
  const chosen = dotVenv ?? inside[0];
  return chosen ? { root: chosen.path } : null;
}
