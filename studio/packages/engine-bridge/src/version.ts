/**
 * version.ts — file 01 §Open-Q7: ENGINE VERSION-SKEW NEGOTIATION.
 *
 * The bundled JS expects a MIN engine. The real engine on disk may be older,
 * newer, or unparseable. This module probes the engine for its SCRIPT_VERSION,
 * then computes a capability map from a semver compare against MIN_ENGINE so
 * callers can feature-flag instead of assuming a wire contract that may not
 * exist on the host's engine.
 *
 * GROUND TRUTH (probed against prometheus.py @ 0.15.0):
 *   - `prometheus.py --version` (argparse, exit 0) prints ONE text line:
 *         `prometheus.py 0.15.0`
 *     => the version is the LAST whitespace token. This is the source of truth.
 *   - `--json doctor` emits HUMAN text, NO JSON object, and no version field.
 *   - No subcommand JSON envelope carries SCRIPT_VERSION today.
 *   So detectEngineVersion runs a RAW spawn of `--version` (it must NOT go
 *   through runPrometheus, which prepends `--json --no-color` and then demands
 *   a JSON envelope that `--version` never produces). We parse the trailing
 *   semver from the printed line.
 *
 * DEGRADE GRACEFULLY (C5 spirit, but for compat not security): a missing engine,
 * a spawn error, a timeout, or an unparseable version NEVER throws here. It
 * yields scriptVersion:null and a capability map with every flag false, so a
 * caller treats an unknown engine as "supports nothing" rather than crashing.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { safeChildEnv } from "./safe-env.js";

import { DEFAULT_TIMEOUT_MS, type EngineConfig, resolveEngine } from "./config.js";

/** The MINIMUM engine SCRIPT_VERSION this bundle's wire contract was built for. */
export const MIN_ENGINE = "0.15.0";

/** Parsed semver triple (pre-release / build metadata are ignored for compare). */
export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

/** Result of probing the engine for its version. raw is the unparsed probe text. */
export interface EngineVersion {
  /** the parsed SCRIPT_VERSION (e.g. "0.15.0"), or null if it could not be read. */
  scriptVersion: string | null;
  /** the raw text the probe produced (the `--version` stdout line, trimmed). */
  raw: string;
  /** parsed semver parts, or null when scriptVersion is null/unparseable. */
  parts: SemverParts | null;
}

/**
 * The feature-flag map negotiated from the engine version. Every flag is a
 * conservative AND of "the engine is at least the version that introduced the
 * feature". On an unknown engine every flag is false (degrade gracefully).
 */
export interface EngineCapabilities {
  /** the version that was negotiated against (echo of EngineVersion.scriptVersion). */
  scriptVersion: string | null;
  /** the bundle's expected minimum (echo of MIN_ENGINE). */
  minEngine: string;
  /** semver comparison of engine vs MIN_ENGINE: -1 older, 0 equal, 1 newer, null unknown. */
  compare: -1 | 0 | 1 | null;
  /** engine meets-or-exceeds the bundle minimum -> the JSON wire contract is trustworthy. */
  jsonContract: boolean;
  /** engine emits forced_danger[] on a --force override (install envelope). */
  supportsForcedDanger: boolean;
  /** engine exposes the `vault` subcommand under --json. */
  supportsVaultJson: boolean;
  /** engine exposes world-simulation features. */
  supportsWorldsim: boolean;
}

/**
 * Parse a semver-ish string ("0.15.0", "v1.2.3", "2.0.0-rc.1+build") into parts.
 * Tolerant of a leading `v` and of pre-release/build suffixes (which are
 * dropped for the compare). Returns null on anything without an x.y.z core.
 */
export function parseSemver(input: unknown): SemverParts | null {
  if (typeof input !== "string") return null;
  const m = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Compare two semver strings. Returns -1 (a<b), 0 (a==b), 1 (a>b). Either side
 * being unparseable yields null (UNKNOWN — callers fail closed on null). The
 * comparison ignores pre-release / build metadata (core triple only).
 */
export function compareSemver(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

/**
 * Pull the SCRIPT_VERSION out of a `prometheus.py --version` line. argparse
 * prints `"<prog> <version>"` (e.g. `prometheus.py 0.15.0`), so the version is
 * the LAST whitespace-delimited token that parses as a semver. We scan tokens
 * right-to-left so a prog name containing digits cannot fool us.
 */
export function parseVersionLine(text: string): string | null {
  const line =
    (text ?? "")
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0] ?? "";
  if (!line) return null;
  const tokens = line.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    if (tok && parseSemver(tok)) return tok.replace(/^v/, "");
  }
  return null;
}

/**
 * Raw, fail-soft spawn of `prometheus.py --version`. Resolves to the trimmed
 * stdout (the version line) or "" on ANY failure (missing file, spawn error,
 * non-zero exit, timeout, abort). NEVER rejects — version probing must not
 * crash the caller; an empty string flows on to yield scriptVersion:null.
 */
function probeVersionRaw(config: EngineConfig, timeoutMs: number): Promise<string> {
  const { prometheusPy, pythonBin } = resolveEngine(config);
  if (!existsSync(prometheusPy)) return Promise.resolve("");

  return new Promise<string>((resolve) => {
    let child;
    try {
      child = spawn(pythonBin, [prometheusPy, "--version"], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: config.cwd,
        // safeChildEnv, like every other spawn in this package (run.ts, security/gate.ts,
        // catalog.ts, sidecar-runner.ts, serve-host.ts, system-probe.ts, modelhub/localai.ts).
        // This was the ONE that handed the raw parent environment to a python child, so an
        // exported PYTHONPATH / PYTHONSTARTUP was re-opened on every version probe — and the
        // probe fires on every sidecar health check, i.e. at desktop and CLI startup.
        env: safeChildEnv(),
      });
    } catch {
      resolve("");
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(text);
    };

    const timer = setTimeout(() => done(""), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("error", () => done(""));
    child.on("close", () => {
      // argparse prints --version to stdout; tolerate stderr fallback just in case.
      done(stdout.trim() || stderr.trim());
    });
  });
}

/** A minimal client view that version probing needs (the EngineConfig it carries). */
export interface VersionProbeTarget {
  config?: EngineConfig;
}

/**
 * detectEngineVersion(client) — probe the engine and return its SCRIPT_VERSION.
 *
 * Accepts either an object carrying an EngineConfig (`{config}`), a bare
 * EngineConfig, or nothing (defaults). Runs the raw `--version` probe and parses
 * the trailing semver. Always resolves; an unreadable engine yields
 * scriptVersion:null with the raw text preserved for diagnostics.
 */
export async function detectEngineVersion(
  client?: VersionProbeTarget | EngineConfig,
  opts: { timeoutMs?: number } = {},
): Promise<EngineVersion> {
  const config: EngineConfig =
    client && typeof client === "object" && "config" in client && client.config
      ? client.config
      : ((client as EngineConfig) ?? {});
  const timeoutMs = opts.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const raw = await probeVersionRaw(config, timeoutMs);
  const scriptVersion = parseVersionLine(raw);
  return {
    scriptVersion,
    raw,
    parts: scriptVersion ? parseSemver(scriptVersion) : null,
  };
}

/**
 * negotiateCapabilities(version) — turn a detected version into a feature map.
 *
 * The comparison is engine-vs-MIN_ENGINE:
 *   - compare === null (engine unparseable)  -> EVERY flag false (degrade).
 *   - compare <  0      (engine OLDER)        -> jsonContract false, every
 *     contract-dependent flag false (we can't trust a wire shape predating us).
 *   - compare >= 0      (engine equal/newer)  -> contract trustworthy; flags on.
 *
 * Newer engines are assumed forward-compatible (the bundle's contract is a
 * subset); if a future engine drops a feature, that's a new MIN bump, not a
 * here-and-now concern. Accepts an EngineVersion OR a bare version string.
 */
export function negotiateCapabilities(
  version: EngineVersion | string | null | undefined,
): EngineCapabilities {
  const scriptVersion = typeof version === "string" ? version : (version?.scriptVersion ?? null);

  const compare = scriptVersion ? compareSemver(scriptVersion, MIN_ENGINE) : null;
  // jsonContract: engine is parseable AND at least MIN_ENGINE (equal or newer).
  const meetsMin = compare === 0 || compare === 1;

  return {
    scriptVersion,
    minEngine: MIN_ENGINE,
    compare,
    jsonContract: meetsMin,
    // All of today's contract features shipped at MIN_ENGINE, so they gate on the
    // same meetsMin check. Splitting them per-feature is where a future engine's
    // finer-grained introduced-at versions would plug in.
    supportsForcedDanger: meetsMin,
    supportsVaultJson: meetsMin,
    supportsWorldsim: meetsMin,
  };
}
