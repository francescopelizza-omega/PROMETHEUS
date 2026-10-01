// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/settings-path.ts — ONE place both surfaces keep the GLOBAL settings layer.
 *
 * There were two. The CLI's global layer is `$PROMETHEUS_HOME/config/settings.json`
 * (apps/cli/src/home.ts) and the desktop's was `<userData>/settings.json` — the same file
 * format, the same product, two different files. So `hooks`, `gateStrict`,
 * `completion.pathFrecency`, `ai.effort`, `budget.*`, `theme`, `keymap`, `templates.user` and
 * `todoPatterns` set at Global scope in Studio were invisible to every terminal session, and
 * the reverse. Studio's own Hooks page even documents Global as
 * `~/.prometheus/config/settings.json`, which was true of the label and not of the file.
 *
 * This is the SAME defect `mcp-store-path.ts` already records for connectors, with the same
 * resolution and for the same reason: `$PROMETHEUS_HOME` is the product-wide root the engine,
 * the audit log, the session store, the grants and the profiles already use, while `userData`
 * is Electron's per-app directory and means nothing to a terminal.
 *
 * MIGRATION is one-way, additive and per-LEAF. A whole-file copy would be wrong: the shared
 * file is also the CLI's, so overwriting it would clobber keys the terminal set (`hooks` above
 * all). Only leaves the shared file does not already define are folded in, so a user who has
 * been running both surfaces keeps the shared file as the newer truth. The old file is then
 * RENAMED to `settings.json.migrated`, not deleted: it is the only copy of the pre-migration
 * state. It must leave the migration's path, though. While it stayed as `settings.json`, the
 * fold ran on EVERY launch, so any global key later removed from the shared file (a Studio
 * Reset, a CLI unset, a deleted file) came back from the stale copy on the next start —
 * `hooks` and `gateStrict` included.
 *
 * Arrays and scalars are single leaves (matching core's `deepMerge`/`flattenLeaves`, where
 * arrays REPLACE wholesale and are never merged per-index), so a desktop-only `todoPatterns`
 * array is adopted whole or not at all — never spliced into the CLI's.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { prometheusHome } from "@prometheus/core/agent-system-host";

/** The shared global layer — the same file the `prometheus` CLI reads and writes. */
export function sharedGlobalSettingsPath(): string {
  return join(prometheusHome(), "config", "settings.json");
}

/** The desktop's former, app-private location. */
export function legacyGlobalSettingsPath(userData: string): string {
  return join(userData, "settings.json");
}

/** Parse a layer file into a record; anything unreadable is an EMPTY record, never a throw. */
function readLayerSync(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A plain record — the only thing that composes. Arrays and null are leaves. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Fold `legacy`'s leaves into `shared` where `shared` does not define them.
 *
 * Returns the adopted count so the caller can SAY it migrated rather than doing it in
 * silence — a setting quietly changing value is indistinguishable from a bug.
 */
function foldMissingLeaves(
  shared: Record<string, unknown>,
  legacy: Record<string, unknown>,
): number {
  let adopted = 0;
  for (const [k, v] of Object.entries(legacy)) {
    if (v === undefined) continue;
    if (isRecord(v) && isRecord(shared[k])) {
      adopted += foldMissingLeaves(shared[k] as Record<string, unknown>, v);
    } else if (!(k in shared)) {
      shared[k] = v;
      adopted += 1;
    }
  }
  return adopted;
}

/**
 * One-time adoption of the desktop's private global layer into the shared one. Once the fold
 * has been written (or there was nothing to fold), the legacy file is renamed out of the way,
 * so it can never be adopted again. Never throws — a failed migration must not stop the app
 * from starting; if the shared write fails, the legacy file stays put and is retried next launch.
 */
export function migrateGlobalSettings(userData: string): number {
  try {
    const legacyPath = legacyGlobalSettingsPath(userData);
    if (!existsSync(legacyPath)) return 0;
    const legacy = readLayerSync(legacyPath);
    let adopted = 0;
    if (Object.keys(legacy).length > 0) {
      const sharedPath = sharedGlobalSettingsPath();
      const shared = readLayerSync(sharedPath);
      adopted = foldMissingLeaves(shared, legacy);
      if (adopted > 0) {
        mkdirSync(dirname(sharedPath), { recursive: true });
        writeFileSync(sharedPath, JSON.stringify(shared, null, 2), "utf8");
      }
    }
    renameSync(legacyPath, `${legacyPath}.migrated`);
    return adopted;
  } catch {
    return 0;
  }
}
