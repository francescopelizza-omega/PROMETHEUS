/**
 * session/hooks-config.ts — load the user's lifecycle HOOKS for a CLI session.
 *
 * Two layers:
 *
 *   global     ~/.prometheus/config/settings.json          (`loadSettings`)
 *   workspace  <cwd>/.prometheus/settings.json             (travels with the repo)
 *
 * This module only LOADS the two raw layers — it no longer decides which one wins. A workspace
 * file is not the user's own input; it arrives with a cloned repo. Handing its `hooks` array
 * straight to a HookRunner would let that repo run arbitrary shell the moment a session opens.
 * `hooks-trust.ts`'s `resolveEffectiveHooks` is what turns these two raw arrays into something
 * safe to execute: a workspace file that omits the key inherits the global list untouched, and
 * one that sets it (even to `[]`, an explicit "none") may re-select from the user's own global
 * hooks and/or introduce new ones — but a new one is NOVEL and must pass a nemesis scan and a
 * one-time trust confirmation before it is ever handed to a runner.
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

/** Whether the effective hook set for a session is attributable to the workspace layer at all
 *  (it set the `hooks` key, even to `[]`) or purely to the user's own global settings. Computed
 *  from presence of the key, independent of how `resolveEffectiveHooks` later vets the entries. */
export type HooksSource = "global" | "workspace";

export interface LoadedHooks {
  /** the global (user-authored, trusted) layer's hooks, unfiltered. */
  globalHooks: HookSpec[];
  /** the workspace layer's hooks, unfiltered — `undefined` when the workspace file never set
   *  the `hooks` key at all (global applies untouched). NOT safe to hand to a HookRunner as-is:
   *  pass both fields to `resolveEffectiveHooks` (hooks-trust.ts) first. */
  workspaceHooks: HookSpec[] | undefined;
}

/**
 * Load the two raw `hooks` layers for a session. This performs no trust decision at all — see
 * the module doc comment and `hooks-trust.ts`.
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
  const globalHooks = agent.validateHooks(global?.hooks ?? []);
  // The workspace layer only contributes when it actually SETS the key (present, even as []).
  const workspaceSet = workspace !== undefined && Object.hasOwn(workspace, "hooks");
  const workspaceHooks = workspaceSet ? agent.validateHooks(workspace.hooks) : undefined;
  return { globalHooks, workspaceHooks };
}
