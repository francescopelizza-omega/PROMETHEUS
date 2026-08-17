/**
 * session/hooks-config.ts — load the user's lifecycle HOOKS for a CLI session.
 *
 * Two layers, in the §7.1 precedence the desktop already uses:
 *
 *   global     ~/.prometheus/config/settings.json          (`loadSettings`)
 *   workspace  <cwd>/.prometheus/settings.json             (highest — travels with the repo)
 *
 * ARRAYS REPLACE, they do not concatenate. That is §7.1's documented rule for arrays, and it is
 * the safer reading here too: a repo that ships `"hooks": []` is stating "no hooks in this
 * project", and a concatenating merge would silently keep running the user's global ones
 * anyway. A workspace file that simply omits the key inherits the global list untouched.
 *
 * FAIL-SOFT throughout: an unreadable or malformed file contributes nothing, and a malformed
 * ROW inside an otherwise good file drops that row (core's `validateHooks`). A settings typo
 * must never stop a session from opening.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { agent } from "@prometheus/core";

import { loadSettings, prometheusHome } from "../home.js";

type HookSpec = agent.HookSpec;

/** The workspace settings file for a repo root (`<root>/.prometheus/settings.json`). */
export function workspaceSettingsPath(cwd: string): string {
  return join(isAbsolute(cwd) ? cwd : resolve(cwd), ".prometheus", "settings.json");
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined; // absent or unparsable → this layer contributes nothing
  }
}

export interface LoadHooksOptions {
  /** PROMETHEUS_HOME (defaults to the resolved home). */
  home?: string;
  /** the session's working directory — the workspace layer's root. */
  cwd?: string;
  /** injected for tests: the raw global settings blob. */
  globalSettings?: Record<string, unknown>;
  /** injected for tests: the raw workspace settings blob. */
  workspaceSettings?: Record<string, unknown>;
}

/** Which settings layer actually supplied the effective `hooks` array (§7.1: arrays replace, so
 *  the WHOLE effective list always comes from exactly one layer — never a blend of both). */
export type HooksSource = "global" | "workspace";

export interface LoadedHooks {
  hooks: HookSpec[];
  /** the layer the effective list came from — "workspace" only when that file actually SETS the
   *  key (present, even as `[]`); "global" otherwise, including the zero-config default. */
  source: HooksSource;
}

/**
 * Resolve the effective `hooks` list for a session, AND which layer it came from — the detail
 * `loadHooks` drops on the floor but `/hooks` (CLI-102) needs to tell a user "this one's from
 * your repo's .prometheus/settings.json, not the global one".
 */
export function loadHooksDetailed(opts: LoadHooksOptions = {}): LoadedHooks {
  const global =
    opts.globalSettings ??
    (() => {
      try {
        return loadSettings(opts.home ?? prometheusHome());
      } catch {
        return {};
      }
    })();
  const workspace =
    opts.workspaceSettings ??
    (opts.cwd ? readJsonRecord(workspaceSettingsPath(opts.cwd)) : undefined);
  // The workspace layer wins only when it actually SETS the key (present, even as []).
  const workspaceWins = workspace !== undefined && Object.hasOwn(workspace, "hooks");
  const raw = workspaceWins ? workspace.hooks : (global?.hooks ?? []);
  return { hooks: agent.validateHooks(raw), source: workspaceWins ? "workspace" : "global" };
}

/**
 * Resolve the effective `hooks` list for a session. Empty when nothing is configured — which is
 * the zero-config default, and makes the loop's hook path a no-op with no runner ever built.
 */
export function loadHooks(opts: LoadHooksOptions = {}): HookSpec[] {
  return loadHooksDetailed(opts).hooks;
}
