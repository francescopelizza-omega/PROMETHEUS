/**
 * updates/check.ts — assemble the UpdateReport from the live seams, throttled + cached.
 *
 * Gathers the three checkers (vendor CLI versions, local Ollama models, Prometheus self) into
 * one report and persists it under ~/.prometheus/updates/state.json with the model-digest
 * snapshot. A startup call is THROTTLED (returns the cached report if checked within the TTL)
 * so it never hammers the network or slows the prompt; `/updates` (force) always re-checks.
 * Every seam is injected (defaults wire fetch.ts/probe.ts), so the orchestration is testable
 * with zero network/spawn. Fail-soft throughout — a dead network yields a partial report, not
 * an error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";

import { updates as u } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import { fetchGithubLatest, fetchNpmLatest, fetchOllamaTags } from "./fetch.js";
import { cliVersion, detectInstallMethod, engineVersion, which } from "./probe.js";

/** Persisted between checks. */
interface UpdateState {
  checkedAt: string;
  digests: u.DigestSnapshot;
  report: u.UpdateReport;
}

export interface CheckDeps {
  home: string;
  /** the prom CLI version (PROM_VERSION). */
  promVersion: string;
  client?: EngineClient;
  env?: NodeJS.ProcessEnv;
  /** process.argv[1] — for install-method detection. */
  scriptPath?: string;
  cwd?: string;
  now?: () => Date;
  /** host RAM in GB (default os.totalmem). */
  ramGb?: number;
  /** override the prometheus repo/npm for self-update (else core defaults). */
  selfConfig?: Partial<u.SelfUpdateConfig>;
  /** throttle window (default 6h). */
  ttlMs?: number;
  /** ignore the throttle + re-check now. */
  force?: boolean;

  /* --- seams (default = the real fetch/probe) --- */
  which?: (bin: string) => boolean;
  cliVersion?: (bin: string, args: readonly string[]) => string | null;
  fetchNpmLatest?: (pkg: string) => Promise<string | null>;
  fetchGithubLatest?: (repo: string) => Promise<string | null>;
  ollamaTags?: () => Promise<u.OllamaModel[]>;
  engineVersionFn?: () => Promise<string | null>;
  detectMethod?: () => { method: u.InstallMethod; repoDir?: string };
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function statePath(home: string): string {
  return join(home, "updates", "state.json");
}

function loadState(home: string): UpdateState | null {
  try {
    return JSON.parse(readFileSync(statePath(home), "utf8")) as UpdateState;
  } catch {
    return null;
  }
}

function saveState(home: string, state: UpdateState): void {
  try {
    mkdirSync(join(home, "updates"), { recursive: true });
    writeFileSync(statePath(home), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* best-effort — a read-only home just means no throttle cache */
  }
}

/** Check every known vendor CLI: installed? current vs latest? */
async function checkClis(deps: CheckDeps): Promise<u.CliUpdateStatus[]> {
  const whichFn = deps.which ?? which;
  const verFn = deps.cliVersion ?? cliVersion;
  const npm = deps.fetchNpmLatest ?? fetchNpmLatest;
  const gh = deps.fetchGithubLatest ?? fetchGithubLatest;
  const out: u.CliUpdateStatus[] = [];
  for (const service of u.UPDATE_SERVICES) {
    const src = u.updateSourceFor(service);
    if (!src) continue;
    const bin = src.bin ?? service;
    const installed = whichFn(bin);
    if (!installed) {
      out.push({
        service,
        installed: false,
        current: null,
        latest: null,
        updateAvailable: false,
        command: src.selfUpdate,
        ...(src.note ? { note: src.note } : {}),
      });
      continue;
    }
    const current = verFn(bin, src.versionArgs);
    let latest: string | null = null;
    if (src.channel === "npm" && src.id) latest = await npm(src.id);
    else if (src.channel === "github" && src.id) latest = await gh(src.id);
    // selfcheck channel (cursor): no remote source — latest stays null.
    const updateAvailable = current !== null && latest !== null && u.isNewer(latest, current);
    out.push({
      service,
      installed: true,
      current,
      latest,
      updateAvailable,
      command: src.selfUpdate,
      ...(src.note ? { note: src.note } : {}),
    });
  }
  return out;
}

/** Check local Ollama models: digest diff vs last snapshot + recommend new free models. */
async function checkModels(
  deps: CheckDeps,
  prevDigests: u.DigestSnapshot,
): Promise<{ status: u.ModelUpdateStatus; digests: u.DigestSnapshot }> {
  const tagsFn = deps.ollamaTags ?? fetchOllamaTags;
  const models = await tagsFn();
  const diff = u.diffDigests(prevDigests, models);
  const ramGb = deps.ramGb ?? Math.round(totalmem() / 1e9);
  const suggestions = u.recommendUpgrades(
    models.map((m) => m.name),
    { ramGb, limit: 3 },
  );
  return { status: { diff, suggestions }, digests: u.snapshotDigests(models) };
}

/** Check Prometheus itself: prom + engine versions, install method, latest, the plan. */
async function checkSelf(deps: CheckDeps): Promise<u.SelfUpdateStatus> {
  const detect = deps.detectMethod ?? (() => detectInstallMethod(deps.scriptPath, deps.cwd));
  const { method, repoDir } = detect();
  const plan = u.buildSelfUpdatePlan({
    method,
    ...(repoDir ? { repoDir } : {}),
    ...(deps.selfConfig ? { config: deps.selfConfig } : {}),
  });
  let engine: string | null = null;
  if (deps.engineVersionFn) engine = await deps.engineVersionFn();
  else if (deps.client) engine = await engineVersion((args) => deps.client!.runPrometheus(args));
  // Self latest: try the configured repo's GitHub releases (fail-soft).
  const cfg = { ...u.DEFAULT_SELF_UPDATE, ...deps.selfConfig };
  const gh = deps.fetchGithubLatest ?? fetchGithubLatest;
  const latest = await gh(cfg.repo);
  const updateAvailable = latest !== null && u.isNewer(latest, deps.promVersion);
  return {
    prom: deps.promVersion,
    ...(engine ? { engine } : {}),
    ...(latest ? { latest } : {}),
    updateAvailable,
    plan,
  };
}

export interface CheckResult {
  report: u.UpdateReport;
  /** true when the cached report was returned (throttle hit). */
  fromCache: boolean;
}

/** Run (or reuse a cached) update check. */
export async function checkUpdates(deps: CheckDeps): Promise<CheckResult> {
  const now = deps.now ? deps.now() : new Date();
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const prev = loadState(deps.home);

  // Throttle: a recent check + no force → reuse the cached report (no network).
  if (!deps.force && prev) {
    const age = now.getTime() - new Date(prev.checkedAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < ttl) {
      return { report: prev.report, fromCache: true };
    }
  }

  const prevDigests = prev?.digests ?? {};
  const [clis, models, self] = await Promise.all([
    checkClis(deps),
    checkModels(deps, prevDigests),
    checkSelf(deps),
  ]);

  const report: u.UpdateReport = {
    clis,
    models: models.status,
    self,
    checkedAt: now.toISOString(),
  };
  saveState(deps.home, { checkedAt: report.checkedAt, digests: models.digests, report });
  return { report, fromCache: false };
}
