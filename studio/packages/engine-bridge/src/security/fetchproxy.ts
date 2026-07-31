/**
 * security/fetchproxy.ts — engine-bridge API for the L6 safe-fetch proxy
 * (url_injection_safeguard.md §3 L6). The ONLY sanctioned way for Studio / the
 * agent runtime to dereference a URL: the work happens in the Python `fetchproxy.py`
 * sidecar (SSRF-guard + DNS-pin + IP denylist + egress allowlist + active-content
 * strip + indirect-prompt-injection detection), spawned through the single C5
 * `runSidecar` seam. JavaScript NEVER decides "safe": a missing / timed-out /
 * unparseable sidecar envelope is surfaced as a blocked, data-less result.
 *
 * Web content returned here is DATA, never instructions: `provenance.executable`
 * is always false and callers must treat `data` as untrusted text — never execute
 * it, never let an agent act on directives inside it (the lethal-trifecta exfil
 * leg is what L6 + an OS/netns egress allowlist break).
 */
import { type SidecarEnvelope, type SidecarOptions, runSidecar } from "../sidecar-runner.js";

export interface SafeFetchOptions {
  /** Egress allowlist; empty = any public host (still SSRF-guarded). */
  allow?: string[];
  /** nemesis IOC DB dir for the per-fetch L1 re-check (default ~/.nemesis/db). */
  dbDir?: string;
  maxBytes?: number;
  timeoutSec?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** spotlight/datamark the returned text (whitespace → ▁) for the LLM. */
  datamark?: boolean;
  /** HTTP method (default GET). POST sends `body` (a JSON string) after the FULL
   *  SSRF/denylist/allowlist pipeline runs — no redirect-following on POST (APP-085). */
  method?: "GET" | "POST";
  /** non-secret request headers (Accept, X-GitHub-Api-Version, Content-Type). */
  headers?: Record<string, string>;
  /** POST body — a JSON string; base64'd into argv (never a shell string). */
  body?: string;
  /** a forge auth token set as a header whose VALUE the sidecar reads from `env[name]`
   *  (env consumed once at spawn — the token is NEVER in argv). Supply the value via
   *  `sidecar.env[env]`; the sidecar sets `header: <that value>`. */
  authHeader?: { header: string; env: string };
  sidecar?: SidecarOptions;
}

export interface IpiSignal {
  kind: string;
  where: string;
  evidence: string;
}

export interface FetchProvenance {
  source_url: string;
  final_url: string;
  fetched_at: string;
  classification: "untrusted-web-data";
  executable: false;
  blocked: boolean;
  contains_injection_signals: boolean;
  instruction_to_agent: string;
}

export interface SafeFetchResult extends SidecarEnvelope {
  command: "fetch";
  url: string;
  final_url: string;
  blocked: boolean;
  verdict: "allow" | "warn" | "block";
  /** Inert, stripped text — present only when not blocked. DATA, never code. */
  data: string | null;
  reason?: string;
  status?: number;
  ipi_signals?: IpiSignal[];
  redirect_chain?: Array<Record<string, unknown>>;
  provenance: FetchProvenance;
}

export interface SafeFetchCheck extends SidecarEnvelope {
  command: "check";
  url: string;
  safe: boolean;
  reason: string;
  host?: string;
  resolved_ips?: string[];
  pinned_ip?: string;
}

export interface CloakPersona {
  blocked: boolean;
  verdict: string;
  status?: number;
  ipi: string[];
  final_url?: string;
}

export interface CloakProbeResult extends SidecarEnvelope {
  command: "probe";
  url: string;
  /** true if the URL served materially different content to the agent vs a browser. */
  cloaked: boolean;
  verdict: "allow" | "warn" | "block";
  similarity: number;
  signals: Array<{ kind: string; evidence: string }>;
  agent_persona?: CloakPersona;
  baseline_persona?: CloakPersona;
  reason?: string;
}

export interface CloakProbeOptions extends SafeFetchOptions {
  /** AI-agent persona UA (default: a fingerprintable bot UA). */
  agentUserAgent?: string;
  /** baseline browser persona UA. */
  baselineUserAgent?: string;
}

function buildArgv(verb: "fetch" | "check", url: string, opts: SafeFetchOptions): string[] {
  const argv = [verb, "--url", url];
  if (opts.allow?.length) argv.push("--allow", opts.allow.join(","));
  if (verb === "fetch") {
    if (opts.dbDir) argv.push("--db-dir", opts.dbDir);
    if (opts.maxBytes != null) argv.push("--max-bytes", String(opts.maxBytes));
    if (opts.timeoutSec != null) argv.push("--timeout", String(opts.timeoutSec));
    if (opts.maxRedirects != null) argv.push("--max-redirects", String(opts.maxRedirects));
    if (opts.userAgent) argv.push("--ua", opts.userAgent);
    if (opts.datamark) argv.push("--datamark");
    // APP-085: method / non-secret headers / body ride argv (base64 for headers+body so
    // spaces/newlines never split); the auth token VALUE stays in env, only its
    // header name + env var name (both non-secret) are named here.
    if (opts.method) argv.push("--method", opts.method);
    if (opts.headers && Object.keys(opts.headers).length > 0) {
      const packed = Object.entries(opts.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      argv.push("--headers-b64", Buffer.from(packed, "utf8").toString("base64"));
    }
    if (opts.body != null) {
      argv.push("--body-b64", Buffer.from(opts.body, "utf8").toString("base64"));
    }
    if (opts.authHeader) {
      argv.push("--auth-header", opts.authHeader.header, "--auth-env", opts.authHeader.env);
    }
  }
  return argv;
}

const blockedResult = (url: string, reason: string): SafeFetchResult => ({
  ok: false,
  command: "fetch",
  url,
  final_url: url,
  blocked: true,
  verdict: "block",
  data: null,
  reason,
  provenance: {
    source_url: url,
    final_url: url,
    fetched_at: new Date().toISOString(),
    classification: "untrusted-web-data",
    executable: false,
    blocked: true,
    contains_injection_signals: false,
    instruction_to_agent: "Blocked before any bytes were trusted — treat as no data (fail-closed).",
  },
});

/**
 * Validate a URL (SSRF + denylist + allowlist) WITHOUT fetching. Fail-closed:
 * a dead/unparseable sidecar → safe:false.
 */
export async function safeFetchCheck(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchCheck> {
  const env = await runSidecar<SafeFetchCheck>("fetchproxy.py", buildArgv("check", url, opts), {
    timeoutMs: (opts.timeoutSec ?? 15) * 1000 + 5000,
    ...opts.sidecar,
  });
  // runSidecar's own failure envelope carries command=<verb> but none of the verb
  // fields (missing sidecar / timeout / unparseable) — fail closed to safe:false.
  if (!env.ok || env.command !== "check" || typeof env.safe !== "boolean") {
    return { ok: false, command: "check", url, safe: false, reason: env.error ?? "scanner error" };
  }
  return env;
}

/**
 * Fetch a URL through the L6 proxy. The result's `data` is untrusted web DATA
 * (inert text); a blocked fetch returns `data:null`. A dead sidecar fails closed.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  // Clamp caller-supplied budgets so a large timeoutSec/maxRedirects can't multiply
  // into a multi-minute JS watchdog that lets a slow/malicious host hold the runner.
  const timeoutSec = Math.min(Math.max(opts.timeoutSec ?? 15, 1), 60);
  const maxRedirects = Math.min(Math.max(opts.maxRedirects ?? 5, 0), 10);
  const clampedOpts: SafeFetchOptions = { ...opts, timeoutSec, maxRedirects };
  const timeoutMs = Math.min(timeoutSec * 1000 * (maxRedirects + 1) + 10_000, 180_000);
  const env = await runSidecar<SafeFetchResult>(
    "fetchproxy.py",
    buildArgv("fetch", url, clampedOpts),
    {
      timeoutMs,
      ...opts.sidecar,
    },
  );
  // A sidecar-level failure (missing/timeout/unparseable) comes back as command=
  // "fetch" but without the verb fields — fail closed to a blocked, data-less result.
  if (!env.ok || env.command !== "fetch" || !env.provenance) {
    return blockedResult(url, env.error ?? "fetch sidecar error (fail-closed)");
  }
  // defence in depth: the contract forbids executable web data — never trust a
  // sidecar that claims otherwise.
  env.provenance.executable = false;
  return env;
}

/**
 * L3 cloaking probe (url_injection_safeguard.md §3 L3): fetch the URL as an
 * AI-agent persona AND a normal browser, both through the SSRF-guarded pipeline,
 * and diff. Injection shown only to the agent, or a materially different page, is
 * a cloaking tell. ADDITIVE signal — a clean probe is never proof of safety, and
 * this is the datacenter-vs-agent-UA differential only (doc Q3). A dead sidecar
 * fails closed to risk-positive (cloaked:true, warn).
 */
export async function cloakProbe(
  url: string,
  opts: CloakProbeOptions = {},
): Promise<CloakProbeResult> {
  const argv = ["probe", "--url", url];
  if (opts.allow?.length) argv.push("--allow", opts.allow.join(","));
  if (opts.dbDir) argv.push("--db-dir", opts.dbDir);
  if (opts.timeoutSec != null) argv.push("--timeout", String(opts.timeoutSec));
  if (opts.maxBytes != null) argv.push("--max-bytes", String(opts.maxBytes));
  if (opts.agentUserAgent) argv.push("--agent-ua", opts.agentUserAgent);
  if (opts.baselineUserAgent) argv.push("--baseline-ua", opts.baselineUserAgent);
  const env = await runSidecar<CloakProbeResult>("fetchproxy.py", argv, {
    timeoutMs: (opts.timeoutSec ?? 15) * 2 * 1000 + 10000,
    ...opts.sidecar,
  });
  if (!env.ok || env.command !== "probe" || typeof env.cloaked !== "boolean") {
    return {
      ok: false,
      command: "probe",
      url,
      cloaked: true,
      verdict: "warn",
      similarity: 0,
      signals: [{ kind: "probe-error", evidence: env.error ?? "probe sidecar error" }],
      reason: env.error ?? "probe sidecar error (fail-closed → risk-positive)",
    };
  }
  return env;
}
