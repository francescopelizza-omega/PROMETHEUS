// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * system/host/permission-rules.ts — read the user's `[permissions]` table off disk.
 *
 * The node half of `agent/permission-config.ts`. ONE loader, called by every surface, so the
 * two CLI hosts, the headless run and the desktop cannot drift into three different answers to
 * "what is this user allowed to do without being asked" — which is exactly how the autonomy
 * ladder came to mean one thing in the TUI and nothing at all in the readline host.
 *
 * The user layer is `~/.config/prometheus-studio/config.toml` — the same file `[keymap]`
 * already lives in, and deliberately NOT a profile TOML: `parseProfile` returns null without an
 * `agent.model`, so permission rules stored there would silently vanish the moment the user
 * switched profiles. Rules are not a profile setting; they are a standing decision.
 *
 * Fail-soft per layer: an unreadable or malformed file contributes nothing and never throws.
 * A permissions file that cannot be parsed must not stop the session — it must only fail to
 * loosen anything, which is the safe direction.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import { configPath, discoverProjectToml } from "../../../cli-profiles/paths.js";
import { getPath, parseToml } from "../../../cli-profiles/toml.js";
import {
  type CompiledPermissionRules,
  type PermissionRulesConfig,
  compilePermissionRules,
} from "../../permission-config.js";

/** Pull `[permissions]` out of a TOML document. Only string arrays survive. */
export function readPermissionsTable(tomlText: string): PermissionRulesConfig {
  const table = getPath(parseToml(tomlText), "permissions");
  if (!table || typeof table !== "object") return {};
  const list = (key: string): string[] | undefined => {
    const v = (table as Record<string, unknown>)[key];
    if (!Array.isArray(v)) return undefined;
    return v.filter((x): x is string => typeof x === "string");
  };
  return {
    ...(list("allow") ? { allow: list("allow") } : {}),
    ...(list("ask") ? { ask: list("ask") } : {}),
    ...(list("deny") ? { deny: list("deny") } : {}),
  };
}

/** Read one layer, or nothing at all. Never throws. */
function layer(path: string | undefined): PermissionRulesConfig {
  if (!path) return {};
  try {
    return readPermissionsTable(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** The user's rules ⊕ the project's (tighten-only) rules, compiled and ordered. */
export function loadPermissionRules(
  opts: { home?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): CompiledPermissionRules {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const user = layer(opts.home ? configPath(opts.home) : configPath());
  // The same opt-out the profile loader honours: a checkout you do not trust.
  const projectPath =
    env.PROM_NO_PROJECT_CONFIG === "1"
      ? undefined
      : discoverProjectToml(cwd, { exists: existsSync, home: opts.home ?? homedir() });
  return compilePermissionRules(user, layer(projectPath));
}
