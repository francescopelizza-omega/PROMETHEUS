// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * cli-profiles/migrate.ts — move an existing install's config into the one Prometheus home.
 *
 * The shared config root used to be `~/.config/prometheus-studio`; it is now
 * `~/.prometheus/config`, so that a product with ONE home does not keep its settings in a
 * second and third place. Everything an existing user already set lives at the old path:
 * `config.toml`, `profiles/`, `grants.json`, `token-toggles.json`, `authorisation.json`,
 * `events.jsonl`. Repointing the resolver without moving those files would silently reset the
 * machine to defaults — which is precisely the failure ("my setting did not survive") this whole
 * change exists to end.
 *
 * Three rules, and each one is there because the alternative loses data:
 *
 *   1. COPY, never move. The originals stay where they are, so an older build — or a rollback —
 *      still finds them. Disk cost is a few KB; the cost of the other choice is the user's
 *      profiles.
 *   2. NEVER overwrite. A file that already exists at the new path is the newer truth and is
 *      left alone, so running this twice (or after the user has already set something) cannot
 *      undo their work.
 *   3. FAIL SOFT. A read-only home, a container with no `$HOME`, a permissions oddity — none of
 *      those may stop a session from opening. The reader-side fallback in `authorisation-store`
 *      and friends means an un-migrated install still WORKS; the migration is an optimisation of
 *      that fallback, not a precondition for it.
 *
 * Called once at startup by each host (the CLI's `bin.ts`, the desktop's main process). It is
 * idempotent and costs one `readdir` on an already-migrated machine.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { configDir, hasLegacyConfigDir, legacyConfigDir } from "./paths.js";

/** What a migration attempt did — returned so a host can log it, and so tests can assert it. */
export interface ConfigMigration {
  /** the source root that was examined. */
  from: string;
  /** the destination root. */
  to: string;
  /** relative paths copied in this run (empty when there was nothing to do). */
  copied: string[];
  /** relative paths skipped because the destination already had them. */
  skipped: string[];
  /** why nothing was copied, when nothing was: `no-legacy` | `failed` | undefined on success. */
  reason?: "no-legacy" | "failed";
}

/** Recursively copy `src` into `dst`, never clobbering, recording what happened. */
function copyTree(src: string, dst: string, rel: string, out: ConfigMigration): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    // A symlink is not followed: copying through one could write outside the destination tree,
    // and a config root is not a place that needs them.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to, relPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (existsSync(to)) {
      out.skipped.push(relPath);
      continue;
    }
    copyFileSync(from, to);
    out.copied.push(relPath);
  }
}

/**
 * Copy `<home>/.config/prometheus-studio` into `<home>/.prometheus/config`, once.
 *
 * `home` is the OS home; omitted, it follows the same default `configDir()` does (which honours
 * `$PROMETHEUS_HOME`). Returns what it did — never throws.
 */
export function migrateLegacyConfigDir(home?: string): ConfigMigration {
  const to = configDir(home);
  const from = legacyConfigDir(home);
  const out: ConfigMigration = { from, to, copied: [], skipped: [] };
  try {
    // `$PROMETHEUS_HOME` means "use THIS tree" — an explicit sandbox, a container, a test. It is
    // not a request to import whatever the real `~/.config` happens to hold, and treating it as
    // one would reach outside the sandbox on every run.
    //
    // The predicate is shared with the READ side (readSavedAuthLevel, readSavedEffort,
    // getActiveProfileName) so the two can never drift: the readers used to fall back to the
    // legacy root unconditionally, quietly undoing this refusal.
    if (!hasLegacyConfigDir(home)) {
      out.reason = "no-legacy";
      return out;
    }
    if (from === to || !existsSync(from) || !statSync(from).isDirectory()) {
      out.reason = "no-legacy";
      return out;
    }
    mkdirSync(to, { recursive: true });
    copyTree(from, to, "", out);
  } catch {
    // A home we cannot read or write is not a reason to refuse a session — the readers fall
    // back to the legacy root on their own.
    out.reason = "failed";
  }
  return out;
}
