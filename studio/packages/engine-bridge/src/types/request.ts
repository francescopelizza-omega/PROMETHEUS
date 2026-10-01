// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/request.ts — the typed REQUEST builders (file 02 §3.3 request side).
 *
 * A small typed surface, not free-form argv. These are the inputs the
 * PrometheusEngine facade (engine.ts) turns into a command line via commands.ts.
 *
 * GROUND TRUTH for flags (prometheus.py @ 0.15.0 argparse):
 *   global flags (BEFORE the subcommand): --dry-run --yes --strict --force.
 *   install/uninstall sub-flags (AFTER the name): --only LIST, --host NAME (repeatable).
 * file 02 §3.3 names the host list `hosts` -> each maps to a `--host` token.
 */

/**
 * InstallRequest — the install builder input.
 * `dryRun` defaults to TRUE in the engine facade (preview first), mirroring the
 * MCP default; engine.ts applies that default so the type can leave it optional.
 */
export interface InstallRequest {
  /** registry plugin name | "all" | "official-bundle". */
  name: string;
  /** component selection -> --only (comma-sep sub-plugin ids). */
  only?: string;
  /** preview without changing anything -> --dry-run (default TRUE in the facade). */
  dryRun?: boolean;
  /** auto-approve non-critical findings -> --yes. */
  yes?: boolean;
  /** block on medium-or-higher findings too -> --strict. */
  strict?: boolean;
  /** DANGER: override a nemesis BLOCK -> --force (yields forced_danger, ok:false). */
  force?: boolean;
  /** restrict target agents -> --host (repeatable). */
  hosts?: string[];
}

/** UninstallRequest — the uninstall builder input (no force/strict path). */
export interface UninstallRequest {
  name: string;
  only?: string;
  dryRun?: boolean;
  /** REQUIRED for a real (non-dry-run) uninstall — engine is non-interactive. */
  yes?: boolean;
  hosts?: string[];
}

/** Which on-disk component a toggle targets (enable/disable --component). */
export type ToggleComponent = "hooks" | "mcp";
