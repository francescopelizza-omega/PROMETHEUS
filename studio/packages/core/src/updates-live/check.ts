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

import type { EngineClient } from "@prometheus/engine-bridge";
import * as u from "../updates/index.js";

import { fetchGitlabLatest } from "./channel-fetch.js";
import { fetchGithubLatest, fetchNpmLatest, fetchOllamaTags } from "./fetch.js";
import { checkModelUpdates, fetchOllamaVersion } from "./model-check.js";
import { type ManagerSweep, sweepPackages } from "./package-sweep.js";
import { cliVersion, detectInstallMethod, engineVersion, which } from "./probe.js";
import { npmGlobalBinDir, onSearchPath } from "./resolve.js";
import { type ToolSweepDeps, legacyCliRows, sweepTools } from "./tool-sweep.js";

/** Persisted between checks. */
interface UpdateState {
  checkedAt: string;
  digests: u.DigestSnapshot;
  report: u.UpdateReport;
}

/**
 * Extends `ToolSweepDeps` so EVERY seam the sweeps use is reachable from one object.
 *
 * Not tidiness. `updates-cmd.test.ts` declares itself "with every network/spawn seam faked (no
 * real fetch, no spawn, temp home)" — and when the tool and package sweeps were added, that
 * promise silently stopped being true: the new code paths had their own IO and the test's seams
 * could not reach them, so a unit test started making real HTTPS requests and spawning `brew`.
 * Inheriting the sweep's dependency type is what makes the seam set complete by construction
 * rather than by remembering.
 */
export interface CheckDeps extends ToolSweepDeps {
  home: string;
  /** the prometheus CLI version (PROM_VERSION). */
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

  /** skip the 16-tool registry sweep (a cheap startup check may want only the cache). */
  skipTools?: boolean;
  /** skip the package-manager sweep, which spawns one process per manager. */
  skipPackages?: boolean;
  /** skip the per-model registry probe. */
  checkUpstream?: boolean;
  /** the ollama DAEMON's version, for the model `requires` gate (default: ask :11434). */
  ollamaVersion?: string;
  /** a running server's version per tool id, for client/server skew detection. */
  serverVersions?: Readonly<Record<string, string>>;
  /** npm's global bin dir; `null` disables the PATH-reachability check entirely. */
  npmBinDir?: string | null;

  /* --- seams (default = the real fetch/probe) --- */
  which?: (bin: string) => boolean;
  cliVersion?: (bin: string, args: readonly string[]) => string | null;
  fetchNpmLatest?: (pkg: string) => Promise<string | null>;
  fetchGithubLatest?: (repo: string) => Promise<string | null>;
  /** where PROMETHEUS's own releases are published. Defaults to GitLab — see `checkSelf`. */
  fetchSelfLatest?: (repo: string) => Promise<string | null>;
  ollamaTags?: () => Promise<u.OllamaModel[]>;
  engineVersionFn?: () => Promise<string | null>;
  detectMethod?: () => { method: u.InstallMethod; repoDir?: string };
  sweepPackagesFn?: (deps: CheckDeps) => ManagerSweep[];
  onPath?: (dir: string) => boolean;
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

/**
 * Check local Ollama models three ways: what changed here, what the registry now serves, and
 * what else is worth having.
 *
 * The middle one is the addition. `diffDigests` compares this machine against its own previous
 * snapshot, so a tag lands in `changed` only once the user has ALREADY pulled it — which is why
 * `countUpdates().models` used to be a hardcoded 0 and the report carried a standing disclaimer
 * that local models were never checked. `checkModelUpdates` asks the registry, and settles most
 * models with a single HEAD request whose response carries the digest directly.
 */
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

  /**
   * The `requires` gate needs the DAEMON's version, not the CLI's — on a machine where the brew
   * formula shadows Ollama.app they are different numbers, and the one that decides whether a
   * model will load is the server's.
   */
  let upstream: u.ModelCheck[] = [];
  if (models.length > 0 && deps.checkUpstream !== false) {
    const ollamaVersion = deps.ollamaVersion ?? (await fetchOllamaVersion());
    upstream = await checkModelUpdates(
      models.map((m) => ({
        name: m.name,
        digest: m.digest,
        ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
        ...(m.modifiedAt !== undefined ? { modifiedAt: m.modifiedAt } : {}),
      })),
      ollamaVersion ? { ollamaVersion } : {},
    );
  }

  return {
    status: { diff, suggestions, ...(upstream.length > 0 ? { upstream } : {}) },
    digests: u.snapshotDigests(models),
  };
}

/** Check Prometheus itself: prometheus + engine versions, install method, latest, the plan. */
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

  /**
   * GITLAB, not GitHub. The remote is `gitlab.com/red-beard-phoenix/PROMETHEUS` (install.sh:25,
   * `git remote -v`), and this used to query `api.github.com` for a repo that does not exist —
   * so `latest` was always null, `updateAvailable` always false, and the report permanently read
   * "up to date". It also spent one of GitHub's 60 unauthenticated requests per hour on a
   * guaranteed 404, every single check.
   */
  const cfg = { ...u.DEFAULT_SELF_UPDATE, ...deps.selfConfig };
  const fetchLatest = deps.fetchSelfLatest ?? ((repo: string) => fetchGitlabLatest(repo));
  const latest = await fetchLatest(cfg.repo);
  /**
   * `null` means the lookup FAILED — not "nothing newer". Collapsing the two is what turned a
   * check that could never succeed into a reassuring message.
   */
  const updateAvailable = latest === null ? null : u.isNewer(latest, deps.promVersion);
  return {
    prometheus: deps.promVersion,
    ...(engine ? { engine } : {}),
    ...(latest ? { latest } : {}),
    updateAvailable,
    plan,
  };
}

/** Turn a package sweep into the report's manager section. */
function managerReports(sweeps: readonly ManagerSweep[]): u.ManagerReport[] {
  return sweeps.map((s) => ({
    manager: s.manager,
    label: s.label,
    checkable: s.unsupported !== true,
    ok: s.ok,
    packages: s.packages,
    ...(s.note ? { note: s.note } : {}),
  }));
}

/**
 * Manager bin directories that PATH will never search.
 *
 * Measured on the machine this was written for: a `codex update` run rewrote `~/.npmrc` so npm's
 * global prefix became `~/.local/share/npm`, whose `bin` nothing adds to PATH. Every subsequent
 * `npm install -g` therefore exits 0 having installed something unrunnable — which from the
 * outside is indistinguishable from "the update did nothing", the user's exact complaint.
 */
function unreachableBinDirs(
  deps: CheckDeps,
): { manager: string; dir: string; installCommand: string }[] {
  if (deps.npmBinDir === null) return [];
  const dir = deps.npmBinDir ?? npmGlobalBinDir();
  if (!dir) return [];
  const onPath = deps.onPath ?? ((d: string) => onSearchPath(d));
  return onPath(dir)
    ? []
    : [{ manager: "npm (global)", dir, installCommand: "npm install -g <package>" }];
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

  /**
   * The tool sweep and the package sweep answer overlapping questions from opposite ends, and
   * BOTH are needed. `sweepTools` asks a registry what the newest version of a named tool is;
   * `sweepPackages` asks the manager that installed it what this machine would actually get. The
   * second is what catches a Homebrew formula that trails npm by fifteen minor versions, and the
   * first is what catches a tool no package manager owns.
   */
  const [models, self, tools] = await Promise.all([
    checkModels(deps, prevDigests),
    checkSelf(deps),
    deps.skipTools ? Promise.resolve([] as u.ToolUpdateStatus[]) : sweepTools(u.TOOL_CHECKS, deps),
  ]);

  /**
   * The package sweep runs AFTER the network work, never alongside it.
   *
   * It is built on `spawnSync`, which blocks the event loop for as long as the child runs — and
   * `brew outdated` takes about two seconds. Every concurrent async operation stalls for that
   * whole time, including the AbortController timers behind the registry probes. MEASURED: run
   * inside the same `Promise.all`, the model check silently produced nothing at all, because its
   * 4-second per-request deadline elapsed while `brew` held the loop. Standalone, the identical
   * call found qwen3.6:latest had moved to a newer build.
   *
   * That is the worst failure mode this feature has: not an error, just an empty result rendered
   * as "not checked". Sequencing costs ~2s on a check that already runs in the background.
   */
  const sweeps: ManagerSweep[] = deps.skipPackages
    ? []
    : (deps.sweepPackagesFn ?? sweepPackages)(deps);

  const managers = managerReports(sweeps);
  /**
   * The cross-check, and the reason this feature exists at all. Neither sweep can see a conflict
   * on its own: `brew outdated` naming `claude-code 2.1.274 -> 2.1.277` is true, and "you run
   * 2.1.284 from a different install" is true, and only together do they say that the upgrade is
   * a downgrade into a path PATH never reaches.
   */
  const conflicts = u.findConflicts({
    resolutions: tools
      .filter((t) => t.installed)
      .map((t) => ({
        tool: t.id,
        copies: t.copies,
        state: t.state,
        ...(t.copies[0] ? { winner: t.copies[0] } : {}),
        shadowed: t.copies.slice(1),
      })),
    outdated: sweeps.flatMap((s) => s.packages),
    unreachableBinDirs: unreachableBinDirs(deps),
    ...(deps.serverVersions ? { serverVersions: deps.serverVersions } : {}),
  });

  const report: u.UpdateReport = {
    // Derived from `tools`, never fetched twice — two sections of one report must not be able to
    // disagree about the same tool.
    clis: tools.length > 0 ? legacyCliRows(tools) : await checkClis(deps),
    models: models.status,
    self,
    checkedAt: now.toISOString(),
    ...(tools.length > 0 ? { tools } : {}),
    ...(managers.length > 0 ? { managers } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
  saveState(deps.home, { checkedAt: report.checkedAt, digests: models.digests, report });
  return { report, fromCache: false };
}
