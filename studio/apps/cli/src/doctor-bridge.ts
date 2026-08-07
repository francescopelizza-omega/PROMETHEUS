/**
 * doctor-bridge.ts — `prometheus doctor --bridge` engine-discovery check (file 11 §8).
 *
 * Verifies the bridge end-to-end: where prometheus.py / nemesis / python resolve
 * (via enginePaths — env → bundled → sibling → PATH), and that the --json contract
 * actually works (a real `scan` round-trip). Prints exactly what it found so
 * "installed but the engine isn't found" fails LOUDLY, not silently.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EnginePaths,
  MIN_ENGINE,
  compareSemver,
  detectEngineVersion,
  enginePaths,
  probeSystemCommand,
  runPrometheus,
} from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "./context.js";
import { c, heading, table } from "./render.js";

/* ── CLI-087: cached startup engine-version handshake + throttled skew warning ────── */

export type HandshakeVerdict = "ok" | "mismatch" | "missing" | "unknown";

/** The persisted handshake cache (`<home>/engine-handshake.json`) — distinct from the updates
 *  cache (independent 24h vs 6h TTLs). Cache-key: enginePath + the file's mtimeMs (sub-second). */
export interface HandshakeCache {
  enginePath: string;
  mtimeMs: number;
  scriptVersion: string | null;
  verdict: HandshakeVerdict;
  /** ISO — when the version was last detected (mtime is the real invalidator). */
  checkedAt: string;
  /** ISO — when the warning was last EMITTED (24h throttle). */
  warnedAt?: string;
  /** the verdict last warned about — a verdict CHANGE re-emits even inside the window. */
  warnedVerdict?: HandshakeVerdict;
}

export interface HandshakeDeps {
  home: string;
  now?: () => Date;
  /** resolve the engine script path cheaply (no spawn); default = enginePaths().py. */
  enginePath?: () => string | undefined;
  /** the engine file's mtimeMs, or null when missing/unstat-able; default = statSync. */
  statMtime?: (path: string) => number | null;
  /** detect the engine version — ONLY called on a cache miss; default = detectEngineVersion. */
  detectVersion?: () => Promise<string | null>;
  readCache?: () => HandshakeCache | null;
  writeCache?: (c: HandshakeCache) => void;
  /** warn-throttle window; default 24h. */
  throttleMs?: number;
}

export interface HandshakeResult {
  verdict: HandshakeVerdict;
  /** the ONE warn line to print, or null (ok / throttled). */
  warning: string | null;
  /** false ⇒ pure cache hit (no version probe spawned) — asserted in tests. */
  probed: boolean;
}

const HANDSHAKE_TTL_MS = 24 * 60 * 60 * 1000; // 24h warn throttle

function handshakeCachePath(home: string): string {
  return join(home, "engine-handshake.json");
}

function defaultStatMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function classifyEngine(scriptVersion: string | null): HandshakeVerdict {
  if (scriptVersion === null) return "unknown";
  const cmp = compareSemver(scriptVersion, MIN_ENGINE);
  return cmp === -1 ? "mismatch" : cmp === null ? "unknown" : "ok";
}

function handshakeWarnLine(verdict: HandshakeVerdict, scriptVersion: string | null): string {
  if (verdict === "missing") return "engine not found — run: prometheus doctor";
  if (verdict === "mismatch")
    return `engine ${scriptVersion ?? "?"} < required ${MIN_ENGINE} — run: prometheus doctor`;
  return "engine version unknown — run: prometheus doctor";
}

/**
 * CLI-087: a fast, cached engine-version handshake for TUI startup. On a cache HIT (same engine
 * path + mtimeMs) it spawns NOTHING (<50ms); a missing engine file is a spawn-free fast path; only
 * a genuine cache miss probes `detectEngineVersion`. Returns the verdict + the ONE warn line to
 * print (throttled to once per 24h PER VERDICT — a verdict change re-emits). FAIL-SOFT end to end:
 * any cache/IO/probe error is swallowed and startup proceeds (compat check, never a block).
 */
export async function engineHandshake(deps: HandshakeDeps): Promise<HandshakeResult> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const nowIso = now.toISOString();
    const throttleMs = deps.throttleMs ?? HANDSHAKE_TTL_MS;
    const enginePath = (deps.enginePath ?? (() => enginePaths().py))();
    const statMtime = deps.statMtime ?? defaultStatMtime;
    const mtimeMs = enginePath ? statMtime(enginePath) : null;
    const readCache = deps.readCache ?? (() => defaultReadHandshake(deps.home));
    const cache = safeCall(readCache);

    const cacheValid =
      !!cache &&
      !!enginePath &&
      mtimeMs !== null &&
      cache.enginePath === enginePath &&
      cache.mtimeMs === mtimeMs;

    let verdict: HandshakeVerdict;
    let scriptVersion: string | null;
    let probed = false;
    if (cacheValid && cache) {
      verdict = cache.verdict;
      scriptVersion = cache.scriptVersion;
    } else if (!enginePath || mtimeMs === null) {
      verdict = "missing"; // spawn-free fast path
      scriptVersion = null;
    } else {
      probed = true;
      scriptVersion = deps.detectVersion
        ? await deps.detectVersion()
        : (await detectEngineVersion()).scriptVersion;
      verdict = classifyEngine(scriptVersion);
    }

    // throttle: warn on a non-ok verdict at most once per window PER VERDICT (a change re-warns).
    const lastWarnedAt = cache?.warnedAt ? new Date(cache.warnedAt).getTime() : 0;
    const throttled = verdict === cache?.warnedVerdict && now.getTime() - lastWarnedAt < throttleMs;
    const shouldWarn = verdict !== "ok" && !throttled;
    const warning = shouldWarn ? handshakeWarnLine(verdict, scriptVersion) : null;

    if (!cacheValid || shouldWarn) {
      const writeCache =
        deps.writeCache ?? ((cc: HandshakeCache) => defaultWriteHandshake(deps.home, cc));
      safeCall(() =>
        writeCache({
          enginePath: enginePath ?? "",
          mtimeMs: mtimeMs ?? 0,
          scriptVersion,
          verdict,
          checkedAt: cacheValid && cache ? cache.checkedAt : nowIso,
          ...(shouldWarn ? { warnedAt: nowIso, warnedVerdict: verdict } : {}),
          ...(!shouldWarn && cache?.warnedAt ? { warnedAt: cache.warnedAt } : {}),
          ...(!shouldWarn && cache?.warnedVerdict ? { warnedVerdict: cache.warnedVerdict } : {}),
        }),
      );
    }
    return { verdict, warning, probed };
  } catch {
    return { verdict: "unknown", warning: null, probed: false }; // fail-soft: never block startup
  }
}

function safeCall<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function defaultReadHandshake(home: string): HandshakeCache | null {
  try {
    return JSON.parse(readFileSync(handshakeCachePath(home), "utf8")) as HandshakeCache;
  } catch {
    return null;
  }
}

function defaultWriteHandshake(home: string, cache: HandshakeCache): void {
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(handshakeCachePath(home), `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    /* read-only home → no cache, fail-soft */
  }
}

export interface BridgeReport {
  paths: EnginePaths;
  pyFound: boolean;
  nemesisFound: boolean;
  /** the --json round-trip succeeded (a real scan envelope came back). */
  probeOk: boolean;
  /** the ollama runner BINARY is present on PATH (CLI-027). Binary-present, NOT daemon-up. */
  runnerFound: boolean;
  error?: string;
}

/** Resolve + probe the engine bridge. Never throws — a failed probe is reported. */
export async function probeBridge(): Promise<BridgeReport> {
  const paths = enginePaths();
  const pyFound = existsSync(paths.py);
  const nemesisFound = existsSync(paths.nemesis);
  // ollama --version exits 0 even with the daemon down → this proves the BINARY exists,
  // not that the server is reachable (a separate daemon check is `api/tags`).
  const runnerFound = (await probeSystemCommand("ollama", ["--version"])) !== null;
  let probeOk = false;
  let error: string | undefined;
  try {
    const env = (await runPrometheus(["scan"], { timeoutMs: 60_000 })) as Record<string, unknown>;
    probeOk = typeof env.command === "string" && env.ok === true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { paths, pyFound, nemesisFound, probeOk, runnerFound, ...(error ? { error } : {}) };
}

/** Render the report as a CommandOutcome (exit 0 iff the probe succeeded). */
export async function runDoctorBridge(ctx: CliContext): Promise<CommandOutcome> {
  const r = await probeBridge();
  const mark = (ok: boolean): string => (ok ? "✓" : "✗");
  const lines = [
    "prometheus doctor --bridge",
    `  prometheus.py  ${mark(r.pyFound)}  ${r.paths.py}`,
    `  nemesis        ${mark(r.nemesisFound)}  ${r.paths.nemesis}`,
    `  python         ${r.paths.python}`,
    `  --json probe   ${mark(r.probeOk)}${r.error ? `  (${r.error})` : ""}`,
    `  ollama runner  ${mark(r.runnerFound)}  ${r.runnerFound ? "installed" : "not installed (prometheus model pull offers to install it)"}`,
  ];
  const ok = r.pyFound && r.probeOk;
  return {
    text: lines.join("\n"),
    json: { ok, ...r },
    exitCode: ok ? 0 : 2,
  };
}

/* ── `prometheus doctor` — the comprehensive environment health report (CLI-051) ───────── */

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult {
  status: CheckStatus;
  detail: string;
  /** exactly one actionable remedy line shown under a fail. */
  remedy?: string;
}
export interface DoctorCheck {
  id: string;
  label: string;
  run(): Promise<CheckResult>;
}

/**
 * Injectable seams for every environment probe (CLI-051) so each check is individually stubbable in
 * tests with NO real spawn / fs / network. All spawns route through engine-bridge's `probeCommand`
 * (`probeSystemCommand` — safe-env, timeout, C5 sole-owner); the network probe is a HEAD fetch with
 * a hard AbortController timeout so an air-gapped machine never hangs (offline ⇒ warn, never fail).
 */
export interface DoctorDeps {
  detectEngineVersion: typeof detectEngineVersion;
  probeCommand: (command: string, args: string[]) => Promise<string | null>;
  /** fs.statSync(p).mode, or null when the path is absent. */
  statMode: (path: string) => number | null;
  /** HEAD `url` with a `timeoutMs` cap → reachable? */
  fetchHead: (url: string, timeoutMs: number) => Promise<boolean>;
  platform: NodeJS.Platform;
  /** candidate node-pty spawn-helper paths (build/Release + prebuilds). */
  ptyHelperPaths: string[];
  /** the ollama daemon base URL. */
  ollamaHost: string;
}

async function defaultFetchHead(url: string, timeoutMs: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "HEAD", signal: ac.signal });
    return r.status < 500; // any non-server-error response proves reachability
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function defaultPtyHelperPaths(): string[] {
  const root = join(process.cwd(), "node_modules", "node-pty");
  return [
    join(root, "build", "Release", "spawn-helper"),
    join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    detectEngineVersion: (client, opts) => detectEngineVersion(client, opts),
    probeCommand: (command, args) => probeSystemCommand(command, args),
    statMode: (p) => {
      try {
        return statSync(p).mode;
      } catch {
        return null;
      }
    },
    fetchHead: defaultFetchHead,
    platform: process.platform,
    ptyHelperPaths: defaultPtyHelperPaths(),
    ollamaHost: "http://127.0.0.1:11434",
  };
}

/** Build the ordered doctor check list; each check closes over the injected deps. */
export function buildDoctorChecks(deps: DoctorDeps): DoctorCheck[] {
  return [
    {
      id: "engine",
      label: "engine handshake",
      async run() {
        const v = await deps.detectEngineVersion();
        if (!v.scriptVersion) {
          return {
            status: "fail",
            detail: `engine not found or no --version (${(v.raw ?? "").trim().slice(0, 60) || "no output"})`,
            remedy: "place prometheus.py beside prometheus or set $PROMETHEUS_ENGINE",
          };
        }
        // compareSemver(engine, MIN) === -1 ⇒ engine is OLDER than the minimum.
        if (compareSemver(v.scriptVersion, MIN_ENGINE) === -1) {
          return {
            status: "warn",
            detail: `engine ${v.scriptVersion} is older than the minimum ${MIN_ENGINE}`,
            remedy: `update the engine to >= ${MIN_ENGINE}`,
          };
        }
        return { status: "pass", detail: `engine ${v.scriptVersion} (>= ${MIN_ENGINE})` };
      },
    },
    {
      id: "node-pty",
      label: "node-pty spawn-helper",
      async run() {
        if (deps.platform === "win32") {
          return { status: "warn", detail: "n/a on Windows (conpty — no spawn-helper)" };
        }
        for (const p of deps.ptyHelperPaths) {
          const mode = deps.statMode(p);
          if (mode !== null) {
            if ((mode & 0o111) !== 0)
              return { status: "pass", detail: `spawn-helper executable (${p})` };
            return {
              status: "fail",
              detail: `spawn-helper is present but NOT executable (${p})`,
              remedy: `chmod +x ${p}`,
            };
          }
        }
        return {
          status: "warn",
          detail: "node-pty not installed (terminal panes need it)",
          remedy: "pnpm install (rebuilds node-pty + restores the exec bit)",
        };
      },
    },
    {
      id: "keychain",
      label: "OS keychain",
      async run() {
        if (deps.platform !== "darwin") {
          return { status: "warn", detail: "not applicable on this OS (macOS keychain check)" };
        }
        const out = await deps.probeCommand("security", ["list-keychains"]);
        if (out === null) {
          return {
            status: "fail",
            detail: "the `security` keychain tool did not respond",
            remedy: "ensure /usr/bin/security exists (reinstall macOS command line tools)",
          };
        }
        return { status: "pass", detail: "macOS keychain reachable" };
      },
    },
    {
      id: "ollama",
      label: "ollama daemon",
      async run() {
        if (await deps.fetchHead(`${deps.ollamaHost}/api/tags`, 2000)) {
          return { status: "pass", detail: `ollama daemon reachable (${deps.ollamaHost})` };
        }
        const binary = await deps.probeCommand("ollama", ["--version"]);
        if (binary !== null) {
          return {
            status: "warn",
            detail: "ollama is installed but the daemon is not running",
            remedy: "ollama serve",
          };
        }
        return {
          status: "warn",
          detail: "ollama not installed (local models unavailable)",
          remedy: "install ollama (prometheus model pull offers to)",
        };
      },
    },
    {
      id: "network",
      label: "network",
      async run() {
        if (await deps.fetchHead("https://registry.npmjs.org/", 3000)) {
          return { status: "pass", detail: "network reachable (registry.npmjs.org)" };
        }
        return {
          status: "warn",
          detail: "offline or the registry is unreachable",
          remedy: "check your connection (air-gapped operation is fine — this is only a warning)",
        };
      },
    },
  ];
}

function statusMark(s: CheckStatus): string {
  return s === "pass" ? c.green("✓") : s === "warn" ? c.yellow("⚠") : c.red("✗");
}

/** `prometheus doctor` — run every environment check, render a table (+ --json), exit 1 iff any FAILS. */
export async function runDoctor(
  ctx: CliContext,
  deps: DoctorDeps = defaultDoctorDeps(),
): Promise<CommandOutcome> {
  const checks = buildDoctorChecks(deps);
  const results = await Promise.all(
    checks.map(async (chk) => ({ id: chk.id, label: chk.label, ...(await chk.run()) })),
  );
  const anyFail = results.some((r) => r.status === "fail");
  const exitCode = anyFail ? 1 : 0;
  if (ctx.json) return { json: { ok: !anyFail, checks: results }, exitCode };
  const lines = [heading("prometheus doctor — environment health"), ""];
  lines.push(
    table(
      [{ header: "CHECK" }, { header: "" }, { header: "DETAIL" }],
      results.map((r) => [r.label, statusMark(r.status), r.detail]),
    ),
  );
  for (const r of results) {
    if (r.status !== "pass" && r.remedy) lines.push(c.dim(`  ↳ ${r.label}: ${r.remedy}`));
  }
  lines.push("", anyFail ? c.red("✗ some checks failed") : c.green("✓ environment OK"));
  return { text: lines.join("\n"), exitCode };
}
