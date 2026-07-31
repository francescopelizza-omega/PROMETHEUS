/**
 * modelhub/localai.ts — a typed LIVE passthrough to the engine's `localai` command
 * (file 05 §6) for {audit, models, endpoints, show, model}.
 *
 * The engine OWNS the open-model catalog + repoint recipes (LOCAL_AI_ENDPOINTS /
 * OPEN_AI_ENDPOINTS / AI_BILLING). This module never re-implements them — it RUNS the
 * real `prometheus.py --json localai <sub>` LIVE and structures its output.
 *
 * WHY A RAW RUNNER (not `runPrometheus`): the engine's `localai` subcommand prints
 * HUMAN TABLES on stdout (it has no JSON-envelope path today), so `run.ts`'s
 * `runPrometheus` — which mandates a recoverable JSON object and throws `bad_json`
 * otherwise — cannot consume it. We therefore spawn the engine here (engine-bridge is
 * the ONLY package allowed to spawn python3 — C5) and return the raw stdout split into
 * lines, plus a best-effort structured projection. This GENUINELY executes the engine;
 * it does not fabricate a catalog. For the STRUCTURED endpoints/repoint views, prefer
 * ModelHubClient.endpoints()/repoint() (the sidecar already parses them into clean JSON
 * envelopes); this module is the broader raw passthrough the Hub uses for audit/models.
 *
 * FAIL-CLOSED: a missing engine / spawn failure / timeout / non-zero exit resolves to
 * `{ok:false, error}` (never a silent success). No security decision is made here (C5).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { type EngineConfig, resolveEngine } from "../config.js";
import { safeChildEnv } from "../safe-env.js";

export type LocalaiSub = "audit" | "models" | "endpoints" | "show" | "model";

export interface LocalaiOptions {
  timeoutMs?: number;
  cwd?: string;
  config?: EngineConfig;
}

/** The structured passthrough result — raw lines + a host-classified endpoint view. */
export interface LocalaiResult {
  ok: boolean;
  sub: LocalaiSub;
  /** the LIVE human output, split into non-empty trimmed lines (ANSI stripped). */
  lines: string[];
  /** `name → base_url` rows (from the v1 envelope, or the legacy table scrape). */
  endpoints: Array<{ name: string; baseUrl: string; scope: "local" | "open-api" }>;
  /** absolute path of the engine that actually ran. */
  engine?: string;
  error?: string;
  /** the full raw stdout (escape hatch). */
  raw: string;
  /** the envelope schema version when the engine shipped one (CLI-026); absent on legacy. */
  version?: number;
  /** the full parsed envelope payload (CLI-026) when present. */
  payload?: Record<string, unknown>;
  /** a non-fatal advisory (e.g. an envelope newer than this client). */
  note?: string;
}

// ANSI SGR escape codes (the engine emits color even under --no-color in some paths).
const ANSI = /\x1b\[[0-9;]*m/g;
const ROW = /^\s*(\S+)\s{2,}(https?:\/\/\S+)/;

/** The schema version this client understands; a higher engine version → best-effort + note. */
export const LOCALAI_CLIENT_VERSION = 1;

function isLocalUrl(url: string): boolean {
  return (
    url.includes("localhost") || url.includes("127.0.0.1") || url.includes("host.docker.internal")
  );
}

function structure(sub: LocalaiSub, stdout: string): LocalaiResult["endpoints"] {
  const out: LocalaiResult["endpoints"] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(ANSI, "");
    const m = ROW.exec(line);
    if (!m) continue;
    const name = m[1] as string;
    const url = m[2] as string;
    out.push({ name, baseUrl: url, scope: isLocalUrl(url) ? "local" : "open-api" });
  }
  return out;
}

/** Collect `{prov:url}` maps from the v1 envelope into the scoped endpoint list. */
function endpointsFromEnvelope(env: Record<string, unknown>): LocalaiResult["endpoints"] {
  const out: LocalaiResult["endpoints"] = [];
  const addMap = (m: unknown, scope: "local" | "open-api"): void => {
    if (m && typeof m === "object") {
      for (const [name, url] of Object.entries(m as Record<string, unknown>)) {
        if (typeof url === "string") out.push({ name, baseUrl: url, scope });
      }
    }
  };
  addMap(env.local, "local"); // endpoints action
  addMap(env.open, "open-api");
  addMap(env.local_endpoints, "local"); // audit action
  addMap(env.open_endpoints, "open-api"); // models action
  return out;
}

/**
 * Project a v1 `localai` envelope into a LocalaiResult (CLI-026). Pure + testable — the
 * live spawner calls this once the envelope parses; a version newer than this client is
 * surfaced as a `note` (best-effort projection), NEVER re-scraped.
 */
export function projectLocalaiEnvelope(
  sub: LocalaiSub,
  env: Record<string, unknown>,
  humanLines: string[],
  engine: string,
  raw: string,
): LocalaiResult {
  const version = typeof env.version === "number" ? env.version : 0;
  const result: LocalaiResult = {
    ok: env.ok !== false,
    sub,
    lines: humanLines,
    endpoints: endpointsFromEnvelope(env),
    engine,
    raw,
    version,
    payload: env,
  };
  if (typeof env.error === "string") result.error = env.error;
  if (version > LOCALAI_CLIENT_VERSION) {
    result.note = `engine localai envelope v${version} is newer than this client (v${LOCALAI_CLIENT_VERSION}) — some fields may be unread`;
  }
  return result;
}

/**
 * Run `prometheus.py --json localai <sub> [...args]` LIVE and structure its output.
 * The args are passed verbatim (shell:false). FAIL-CLOSED on any transport failure.
 */
export function localai(
  sub: LocalaiSub,
  args: string[] = [],
  opts: LocalaiOptions = {},
): Promise<LocalaiResult> {
  const { prometheusPy, pythonBin } = resolveEngine(opts.config);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const fail = (error: string): LocalaiResult => ({
    ok: false,
    sub,
    lines: [],
    endpoints: [],
    engine: prometheusPy,
    error,
    raw: "",
  });

  if (!existsSync(prometheusPy)) {
    return Promise.resolve(fail(`prometheus.py not found at ${prometheusPy} (set PROMETHEUS_PY)`));
  }

  const fullArgv = [prometheusPy, "--json", "--no-color", "localai", sub, ...args];

  return new Promise<LocalaiResult>((resolve) => {
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
    const done = (r: LocalaiResult) => {
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
      done(fail(`localai timed out after ${Math.round(timeoutMs / 1000)}s`));
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
        done(fail("localai emitted more than 64MB — aborted (fail-closed)"));
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.stdin?.end();

    child.on("error", (err: Error) => done(fail(`failed to launch ${pythonBin}: ${err.message}`)));

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        const tail = (stderr.trim() || stdout.trim() || `exit ${code}`).slice(-300);
        done(fail(`localai exit ${code}: ${tail}`));
        return;
      }
      // v1+ envelope path (CLI-026): under --json the human output goes to stderr and a
      // single JSON envelope lands on stdout. Version-branch on it; the table scrape is
      // now a fallback for pre-envelope engines only (never re-triggered by a v1 blob).
      const humanLines = stderr
        .split("\n")
        .map((l) => l.replace(ANSI, "").trimEnd())
        .filter((l) => l.trim().length > 0);
      const trimmed = stdout.trim();
      if (trimmed.startsWith("{")) {
        try {
          const env = JSON.parse(trimmed);
          if (env && typeof env === "object" && typeof env.version === "number") {
            done(projectLocalaiEnvelope(sub, env, humanLines, prometheusPy, stdout));
            return;
          }
        } catch {
          /* not an envelope — fall through to the legacy table scraper */
        }
      }
      // legacy fallback: a pre-envelope engine printed a human table on stdout.
      const lines = stdout
        .split("\n")
        .map((l) => l.replace(ANSI, "").trimEnd())
        .filter((l) => l.trim().length > 0);
      done({
        ok: true,
        sub,
        lines,
        endpoints: structure(sub, stdout),
        engine: prometheusPy,
        raw: stdout,
      });
    });
  });
}

// ── typed sub-command helpers ─────────────────────────────────────────────────

/** LIVE `localai audit` — every AI-using repo it manages + patchable flags. */
export const audit = (opts?: LocalaiOptions): Promise<LocalaiResult> => localai("audit", [], opts);

/** LIVE `localai models` — the open-source-free catalog (OPEN_MODELS + served APIs). */
export const models = (opts?: LocalaiOptions): Promise<LocalaiResult> =>
  localai("models", [], opts);

/** LIVE `localai endpoints` — local servers + big open-weight APIs. */
export const endpoints = (opts?: LocalaiOptions): Promise<LocalaiResult> =>
  localai("endpoints", [], opts);

/** LIVE `localai show <tool>` — billing/patchability/recipe for one AI tool. */
export const show = (tool: string, opts?: LocalaiOptions): Promise<LocalaiResult> =>
  localai("show", [tool], opts);

/** LIVE `localai model <family>` — the recipe for one open-model family. */
export const model = (family: string, opts?: LocalaiOptions): Promise<LocalaiResult> =>
  localai("model", [family], opts);
