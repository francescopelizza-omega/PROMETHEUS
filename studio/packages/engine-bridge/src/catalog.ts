/**
 * catalog.ts — the READ surface of the catalog manager (file 06 §4.2 / §8).
 *
 * Typed methods over the EXISTING `runPrometheus` (engine-bridge is the ONLY JS->engine
 * gateway — C5). Two shapes of engine command live here:
 *
 *   1. JSON-ENVELOPE commands (verified LIVE — these REALLY emit one JSON object on
 *      stdout): list, info <name>, where <name>, matrix, status <name|"all">,
 *      audit <name>, superscan, skills list, vault (status). These return the parsed
 *      engine envelope through `runPrometheus`.
 *
 *   2. HUMAN-TABLE commands (verified LIVE — these print a human table on stdout and
 *      have NO --json envelope path today): apps list/installed, worldsim list,
 *      models list, localai *, inventory. `runPrometheus` (which mandates a recoverable
 *      JSON object) cannot consume these, so they go through `rawEngine` — the SAME
 *      pattern modelhub/localai.ts uses: spawn the engine (still the ONLY spawner, C5)
 *      and return its stdout split into lines + a best-effort row projection. This
 *      GENUINELY runs the engine; it never fabricates a catalog.
 *
 * This module adds ONLY the not-yet-wired reads (apps/worldsim/models/localai/inventory
 * + skillsList) plus typed wrappers for the already-wired JSON reads — it does NOT
 * duplicate the EngineClient methods (scan/list/info/where/status/matrix/audit/…),
 * it COMPOSES the same `runPrometheus`. NOTHING here decides "safe" (C5): `audit`
 * surfaces the verdict the engine/nemesis computed; it never recomputes one.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { Commands } from "./commands.js";
import { type EngineConfig, resolveEngine } from "./config.js";
import { type EngineEnvelope, type RunOptions, runPrometheus } from "./run.js";
import { safeChildEnv } from "./safe-env.js";

// ── option bags ───────────────────────────────────────────────────────────────

export interface CatalogClientOptions {
  config?: EngineConfig;
  timeoutMs?: number;
  cwd?: string;
}

/** Audit flags: `--strict` / `--gate-fresh` are GLOBAL flags (before the subcommand). */
export interface AuditOptions extends RunOptions {
  strict?: boolean;
  gateFresh?: boolean;
}

/** apps/worldsim/models actions all share `{path?, version?}` (file 06 §4.4). */
export interface AppActionOptions {
  path?: string;
  version?: string;
}

// ── the raw human-table passthrough (apps/worldsim/models/localai/inventory) ──

/** The structured passthrough result — raw lines + the engine that actually ran. */
export interface RawEngineResult {
  ok: boolean;
  /** the subcommand (e.g. "apps", "worldsim", "models", "inventory", "localai"). */
  command: string;
  /** the action positional, when present ("list", "installed", "audit", …). */
  action?: string;
  /** the LIVE stdout, ANSI-stripped + split into non-empty lines. */
  lines: string[];
  /** absolute path of the engine that actually ran. */
  engine?: string;
  error?: string;
  /** the full raw stdout (escape hatch). */
  raw: string;
}

// ANSI SGR escape codes (the engine emits color even under --no-color in some paths).
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Run a HUMAN-TABLE engine command LIVE and return its stdout lines. The args are
 * passed verbatim (shell:false). FAIL-CLOSED on any transport failure (missing engine,
 * spawn failure, timeout, non-zero exit) → `{ok:false, error}` — never a silent success.
 * No security decision is made here (C5) — these are read-only catalog renders.
 */
export function rawEngine(
  argv: string[],
  opts: CatalogClientOptions = {},
): Promise<RawEngineResult> {
  const { prometheusPy, pythonBin } = resolveEngine(opts.config);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  // name the command from the first NON-FLAG token, so a caller that prepends §1
  // global flags (e.g. `--dry-run apps install …`) still reports command "apps".
  const subIdx = argv.findIndex((a) => !a.startsWith("-"));
  const command = (subIdx >= 0 ? argv[subIdx] : argv[0]) ?? "engine";
  const actionTok = subIdx >= 0 ? argv[subIdx + 1] : argv[1];
  const action = actionTok && !actionTok.startsWith("-") ? actionTok : undefined;

  const fail = (error: string): RawEngineResult => ({
    ok: false,
    command,
    action,
    lines: [],
    engine: prometheusPy,
    error,
    raw: "",
  });

  if (!existsSync(prometheusPy)) {
    return Promise.resolve(fail(`prometheus.py not found at ${prometheusPy} (set PROMETHEUS_PY)`));
  }

  const fullArgv = [prometheusPy, "--json", "--no-color", ...argv];

  return new Promise<RawEngineResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonBin, fullArgv, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.cwd,
        env: safeChildEnv(),
      });
    } catch (err) {
      resolve(fail(`failed to launch ${pythonBin}: ${(err as Error).message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: RawEngineResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      done(fail(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
      if (stdout.length > 64 * 1024 * 1024) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        done(fail(`${command} emitted more than 64MB — aborted (fail-closed)`));
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.stdin?.end();

    child.on("error", (err: Error) => done(fail(`failed to launch ${pythonBin}: ${err.message}`)));

    child.on("close", (code: number | null) => {
      // The engine returns non-zero for some read paths (e.g. audit with findings);
      // for these human-table READS we treat any produced stdout as a successful read
      // and only fail-close when there is genuinely no output AND a non-zero exit.
      const lines = stdout
        .split("\n")
        .map((l) => l.replace(ANSI, "").trimEnd())
        .filter((l) => l.trim().length > 0);
      if (lines.length === 0 && code !== 0) {
        const tail = (stderr.trim() || `exit ${code}`).slice(-300);
        done(fail(`${command} exit ${code}: ${tail}`));
        return;
      }
      done({ ok: true, command, action, lines, engine: prometheusPy, raw: stdout });
    });
  });
}

// ── the client ────────────────────────────────────────────────────────────────

/**
 * The catalog READ client. Read-only by construction — every method is a query, none
 * change state (that is lifecycle.ts). JSON-envelope reads return the parsed
 * `EngineEnvelope`; human-table reads return a `RawEngineResult`.
 */
export class CatalogClient {
  private readonly opts: CatalogClientOptions;

  constructor(opts: CatalogClientOptions = {}) {
    this.opts = opts;
  }

  private run<T extends EngineEnvelope = EngineEnvelope>(
    argv: string[],
    extra?: RunOptions,
  ): Promise<T> {
    return runPrometheus<T>(
      argv,
      { timeoutMs: this.opts.timeoutMs, cwd: this.opts.cwd, ...extra },
      this.opts.config ?? {},
    );
  }

  private raw(argv: string[]): Promise<RawEngineResult> {
    return rawEngine(argv, this.opts);
  }

  // --- JSON-envelope reads (verified LIVE) ------------------------------------ //

  /** `list` → `{catalog:[…], detected_agents:[…]}` — the six-registry catalog. */
  list(opts?: RunOptions): Promise<EngineEnvelope> {
    return this.run(Commands.list(), opts);
  }

  /** `info <name>` → full Plugin detail (`cmd_info`). */
  info(name: string, opts?: RunOptions): Promise<EngineEnvelope> {
    return this.run(Commands.info(name), opts);
  }

  /** `where <name>` → `{plugin:{targets:[{agent,method,dest,…}]}}` (`cmd_where`). */
  where(name: string, opts?: RunOptions): Promise<EngineEnvelope> {
    return this.run(Commands.where(name), opts);
  }

  /** `matrix` → `{agents:[…], reach:[{plugin,scope,native,sync,unavailable}]}`. */
  matrix(opts?: RunOptions): Promise<EngineEnvelope> {
    return this.run(Commands.matrix(), opts);
  }

  /** `status <name|"all">` → install + enabled/disabled per component. */
  status(name: string | "all", opts?: RunOptions): Promise<EngineEnvelope> {
    return this.run(Commands.status(name), opts);
  }

  /**
   * `audit <name>` (scan, no install) → the nemesis verdict + findings, no state change.
   * `--strict` / `--gate-fresh` are GLOBAL flags (BEFORE the subcommand). The verdict
   * the engine/nemesis returns rides through UNCHANGED — JS never recomputes it (C5).
   */
  audit(name: string, opts: AuditOptions = {}): Promise<EngineEnvelope> {
    const { strict, gateFresh, ...run } = opts;
    const argv = [
      ...(strict ? ["--strict"] : []),
      ...(gateFresh ? ["--gate-fresh"] : []),
      ...Commands.audit(name),
    ];
    return this.run(argv, run);
  }

  /** `superscan` → the deep per-agent install census (`cmd_superscan`). */
  superscan(opts?: RunOptions): Promise<EngineEnvelope> {
    return this.run(Commands.superscan(), opts);
  }

  /** `skills list` → `{action:"list", skills_dir, skills:[…]}` (`cmd_skills`). */
  skillsList(opts?: RunOptions): Promise<EngineEnvelope> {
    return this.run(["skills", "list"], opts);
  }

  /** `vault` (status) → `{action:"status", repos:[…], summary}` (`cmd_vault`). */
  vaultStatus(opts?: RunOptions): Promise<EngineEnvelope> {
    return this.run(Commands.vaultStatus(), opts);
  }

  // --- human-table reads (no JSON envelope — verified LIVE) ------------------- //

  /** `apps list` — the REPO_TOOLS catalog (4th fn). Human-table passthrough. */
  appsList(): Promise<RawEngineResult> {
    return this.raw(["apps", "list"]);
  }

  /** `apps installed` — installed apps + Studio reconcile source. Human-table. */
  appsInstalled(): Promise<RawEngineResult> {
    return this.raw(["apps", "installed"]);
  }

  /** `apps <action> [tool] [--path] [--version]` (read actions: status/logs/versions). */
  apps(action: string, tool?: string, opts: AppActionOptions = {}): Promise<RawEngineResult> {
    return this.raw([
      "apps",
      action,
      ...(tool ? [tool] : []),
      ...(opts.path ? ["--path", opts.path] : []),
      ...(opts.version ? ["--version", opts.version] : []),
    ]);
  }

  /** `worldsim list` — the World-Sim engines (8th fn). Human-table passthrough. */
  worldsimList(): Promise<RawEngineResult> {
    return this.raw(["worldsim", "list"]);
  }

  /** `worldsim <action> [tool] [--path] [--version]` (read actions: status/logs/versions). */
  worldsim(action: string, tool?: string, opts: AppActionOptions = {}): Promise<RawEngineResult> {
    return this.raw([
      "worldsim",
      action,
      ...(tool ? [tool] : []),
      ...(opts.path ? ["--path", opts.path] : []),
      ...(opts.version ? ["--version", opts.version] : []),
    ]);
  }

  /** `models list` — the MODEL_TOOLS catalog (3rd fn). Human-table passthrough. */
  modelsList(): Promise<RawEngineResult> {
    return this.raw(["models", "list"]);
  }

  /** `models <action> [tool]` — read actions only here (install/lifecycle = lifecycle.ts). */
  models(action: string, tool?: string): Promise<RawEngineResult> {
    return this.raw(["models", action, ...(tool ? [tool] : [])]);
  }

  /** `localai audit` — every AI-using repo + patchable flags (`cmd_localai`). */
  localaiAudit(): Promise<RawEngineResult> {
    return this.raw(["localai", "audit"]);
  }

  /** `localai models` — the open-source-free model catalog. */
  localaiModels(): Promise<RawEngineResult> {
    return this.raw(["localai", "models"]);
  }

  /** `localai endpoints` — local servers + big open-weight APIs. */
  localaiEndpoints(): Promise<RawEngineResult> {
    return this.raw(["localai", "endpoints"]);
  }

  /** `localai show <tool>` — billing/patchability/recipe for one AI tool. */
  localaiShow(tool: string): Promise<RawEngineResult> {
    return this.raw(["localai", "show", tool]);
  }

  /** `inventory [--host …]` — ALL installed (managed + foreign). Human-table. */
  inventory(opts: { host?: string } = {}): Promise<RawEngineResult> {
    return this.raw(["inventory", ...(opts.host ? ["--host", opts.host] : [])]);
  }
}

// ── module-level convenience (mirrors env.ts / modelhub) ──────────────────────

const defaultClient = new CatalogClient();

export const createCatalogClient = (opts?: CatalogClientOptions): CatalogClient =>
  new CatalogClient(opts);

export const list = (opts?: RunOptions): Promise<EngineEnvelope> => defaultClient.list(opts);
export const info = (name: string, opts?: RunOptions): Promise<EngineEnvelope> =>
  defaultClient.info(name, opts);
export const where = (name: string, opts?: RunOptions): Promise<EngineEnvelope> =>
  defaultClient.where(name, opts);
export const matrix = (opts?: RunOptions): Promise<EngineEnvelope> => defaultClient.matrix(opts);
export const status = (name: string | "all", opts?: RunOptions): Promise<EngineEnvelope> =>
  defaultClient.status(name, opts);
export const audit = (name: string, opts?: AuditOptions): Promise<EngineEnvelope> =>
  defaultClient.audit(name, opts);
export const superscan = (opts?: RunOptions): Promise<EngineEnvelope> =>
  defaultClient.superscan(opts);
export const skillsList = (opts?: RunOptions): Promise<EngineEnvelope> =>
  defaultClient.skillsList(opts);
export const vaultStatus = (opts?: RunOptions): Promise<EngineEnvelope> =>
  defaultClient.vaultStatus(opts);
export const appsList = (): Promise<RawEngineResult> => defaultClient.appsList();
export const appsInstalled = (): Promise<RawEngineResult> => defaultClient.appsInstalled();
export const apps = (
  action: string,
  tool?: string,
  opts?: AppActionOptions,
): Promise<RawEngineResult> => defaultClient.apps(action, tool, opts);
export const worldsimList = (): Promise<RawEngineResult> => defaultClient.worldsimList();
export const worldsim = (
  action: string,
  tool?: string,
  opts?: AppActionOptions,
): Promise<RawEngineResult> => defaultClient.worldsim(action, tool, opts);
export const modelsList = (): Promise<RawEngineResult> => defaultClient.modelsList();
export const models = (action: string, tool?: string): Promise<RawEngineResult> =>
  defaultClient.models(action, tool);
export const localaiAudit = (): Promise<RawEngineResult> => defaultClient.localaiAudit();
export const localaiModels = (): Promise<RawEngineResult> => defaultClient.localaiModels();
export const localaiEndpoints = (): Promise<RawEngineResult> => defaultClient.localaiEndpoints();
export const localaiShow = (tool: string): Promise<RawEngineResult> =>
  defaultClient.localaiShow(tool);
export const inventory = (opts?: { host?: string }): Promise<RawEngineResult> =>
  defaultClient.inventory(opts);
