// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * security/threatdb.ts — Threat-Intelligence DB status & control (file 03 §6).
 *
 * The signature DB / feeds / verdict cache surface. Studio makes the engine's
 * `prepare_nemesis()` auto-seed visible and gives the user control — but NEVER
 * lets a stale/empty DB silently weaken a verdict (§6). All spawns go through the
 * existing runNemesis (the only nemesis spawner — C5). No child_process here.
 *
 * GROUND TRUTH — probed against `nemesis 1.12.0`:
 *   - DB STATUS: there is no dedicated JSON status verb. The freshest source of
 *     truth is `provenance.db.{seeded,age_days,stale}` + `indicators_loaded` on
 *     ANY gate verdict (which prepare_nemesis() seeds first). So threatDbStatus()
 *     gates a tiny throwaway target and reads the provenance off that verdict.
 *   - UPDATE: `nemesis update [--force] [--all] [--feed N] [--list]`. Progress
 *     is on stderr; we stream it via the existing onStderr line callback.
 *   - AUTH:   `nemesis auth --key <K>` (stored chmod-600 in ~/.nemesis/config.json).
 *     The key is NEVER logged/echoed — it is passed as an argv element only.
 *   - CACHE:  `nemesis cache` (status: "<N> entries in <dir>") / `cache --clear`.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineConfig } from "../config.js";
import { type NemesisRunResult, type RunOptions, runNemesis } from "./gate.js";
import {
  type DbProvenance,
  type IndicatorsLoaded,
  type NemesisProvenance,
  parseNemesisVerdict,
} from "./nemesis-verdict.js";

export interface ThreatDbStatus {
  ok: boolean;
  /** seeded / age / stale — drives the §6 banner. */
  db: DbProvenance;
  indicators: IndicatorsLoaded;
  rulesetSha: string;
  /** true ⇒ raise the global "DB blind" banner (§6). */
  blind: boolean;
  error?: string;
}

/** Derive an empty/fail-closed status (DB reads as NOT seeded + stale). */
function blindStatus(error: string): ThreatDbStatus {
  return {
    ok: false,
    db: { seeded: false, age_days: 0, stale: true },
    indicators: {},
    rulesetSha: "",
    blind: true,
    error,
  };
}

/**
 * Report the threat-DB status by gating a tiny throwaway target and reading the
 * provenance off the resulting verdict (prepare_nemesis seeds the DB first).
 * FAIL-SOFT: any failure ⇒ a blind/stale status (never a falsely-healthy one).
 */
export async function threatDbStatus(
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<ThreatDbStatus> {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "eb-dbstat-"));
    writeFileSync(join(dir, ".probe"), "");
  } catch (e) {
    return blindStatus(`could not create probe dir: ${e instanceof Error ? e.message : String(e)}`);
  }

  let res: NemesisRunResult;
  try {
    res = await runNemesis(["gate", dir], opts, config);
  } catch (e) {
    return blindStatus(e instanceof Error ? e.message : String(e));
  }

  if (!res.json) return blindStatus("no verdict JSON to read provenance from");

  const verdict = parseNemesisVerdict(res.json, dir);
  const prov: NemesisProvenance = verdict.provenance;
  return {
    ok: true,
    db: prov.db,
    indicators: prov.indicators_loaded,
    rulesetSha: prov.ruleset_sha,
    // §6: an unseeded DB means hash/IOC/CVE detection is OFF — raise the banner.
    blind: !prov.db.seeded,
  };
}

export interface UpdateFeedsOptions extends RunOptions {
  /** re-download even within TTL (`--force`). */
  force?: boolean;
  /** also fetch opt-in feeds clamav-main / malwarebazaar-full (`--all`). */
  all?: boolean;
  /** restrict to specific feeds (`--feed NAME`, repeatable). */
  feeds?: string[];
}

export interface UpdateFeedsResult {
  ok: boolean;
  /** the trailing stdout summary the engine prints after a successful update. */
  summary: string;
  error?: string;
}

/**
 * Refresh the signature/IOC feeds (`nemesis update`). Long-running; progress is
 * streamed to `opts.onStderr` line-by-line (the engine writes progress to stderr,
 * keeping stdout clean). FAIL-CLOSED: a non-zero exit / spawn failure ⇒ ok:false.
 */
export async function updateFeeds(
  opts: UpdateFeedsOptions = {},
  config: EngineConfig = {},
): Promise<UpdateFeedsResult> {
  const argv = ["update"];
  if (opts.force) argv.push("--force");
  if (opts.all) argv.push("--all");
  for (const f of opts.feeds ?? []) argv.push("--feed", f);
  try {
    const res = await runNemesis(argv, opts, config);
    return {
      ok: res.exitCode === 0,
      summary: res.stdout.trim(),
      error: res.exitCode === 0 ? undefined : `update exited ${res.exitCode}`,
    };
  } catch (e) {
    return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
  }
}

export interface AuthKeyResult {
  ok: boolean;
  error?: string;
}

/**
 * Save the abuse.ch Auth-Key (`nemesis auth --key <K>`). The key unlocks the
 * abuse.ch feeds and is stored chmod-600 by the engine. SECURITY: the key is
 * passed as an argv element ONLY — it is NEVER logged, echoed, or returned, and
 * no stderr stream is wired so a key cannot leak through progress lines.
 * FAIL-CLOSED: a non-zero exit / spawn failure ⇒ ok:false (no detail leakage).
 */
export async function authKey(
  key: string,
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<AuthKeyResult> {
  if (!key?.trim()) return { ok: false, error: "empty key" };
  try {
    // Deliberately drop any onStderr sink: progress text could echo the key.
    const safeOpts: RunOptions = { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal: opts.signal };
    const res = await runNemesis(["auth", "--key", key], safeOpts, config);
    return { ok: res.exitCode === 0, error: res.exitCode === 0 ? undefined : "auth failed" };
  } catch {
    // Swallow the message entirely — it could contain the argv (and thus the key).
    return { ok: false, error: "auth failed" };
  }
}

export interface CacheStatusResult {
  ok: boolean;
  /** the human cache status line ("verdict cache: N entries in <dir>"). */
  status: string;
  /** parsed entry count when derivable, else null. */
  entries: number | null;
  error?: string;
}

/** Read the verdict-cache status (`nemesis cache`). FAIL-SOFT. */
export async function cacheStatus(
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<CacheStatusResult> {
  try {
    const res = await runNemesis(["cache"], opts, config);
    const text = res.stdout.trim() || res.stderr.trim();
    const m = text.match(/cache:\s*(\d+)\s*entries/i);
    return { ok: res.exitCode === 0, status: text, entries: m ? Number(m[1]) : null };
  } catch (e) {
    return {
      ok: false,
      status: "",
      entries: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface ClearCacheResult {
  ok: boolean;
  message: string;
  error?: string;
}

/** Clear the verdict cache (`nemesis cache --clear`). FAIL-SOFT. */
export async function clearCache(
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<ClearCacheResult> {
  try {
    const res = await runNemesis(["cache", "--clear"], opts, config);
    return {
      ok: res.exitCode === 0,
      message: res.stdout.trim() || res.stderr.trim(),
      error: res.exitCode === 0 ? undefined : `cache --clear exited ${res.exitCode}`,
    };
  } catch (e) {
    return { ok: false, message: "", error: e instanceof Error ? e.message : String(e) };
  }
}
