/**
 * security/urlaudit.ts — bridge to the L5 installed-source audit
 * (url_injection_safeguard.md §5.2 / §9). Runs `prometheus.py --json skills audit`
 * so Studio can: re-scan installed external sources (SKILL.md / AGENTS.md / MCP
 * configs), see content drift quarantined (fail-closed, reversible), browse the
 * quarantine vault, and restore a vaulted source after the user re-trusts it.
 *
 * FAIL-CLOSED: a transport failure throws (runPrometheus contract); an ok:false
 * audit envelope is VALID output and returned. JavaScript never decides "safe".
 */
import type { EngineConfig } from "../config.js";
import { type EngineEnvelope, type RunOptions, runPrometheus } from "../run.js";

export interface UrlAuditResult extends EngineEnvelope {
  command: "skills-audit";
  result?: {
    new: Array<{ path: string; kind: string; verdict: string; urls: number }>;
    clean: string[];
    repinned: Array<{ path: string; kind: string; verdict: string; diff?: string[] }>;
    quarantined: Array<{
      original: string;
      vault: string;
      verdict: string;
      restored_blessed?: boolean;
      first_seen?: boolean;
      blocking_reasons?: string[];
      diff?: string[];
    }>;
    missing: string[];
    errors: Array<{ path: string; error: string }>;
  };
  quarantine?: Array<Record<string, unknown>>;
}

/**
 * Re-scan installed sources. `quarantine:false` (default for a passive UI refresh)
 * detects + reports drift without mutating; `quarantine:true` performs the
 * fail-closed quarantine+restore + reversible disable of dangerous sources.
 */
export function urlSourceAudit(
  opts: RunOptions & { quarantine?: boolean } = {},
  config: EngineConfig = {},
): Promise<UrlAuditResult> {
  const argv = ["skills", "audit"];
  if (!opts.quarantine) argv.push("--no-quarantine");
  return runPrometheus<UrlAuditResult>(argv, opts, config);
}

/** List the URL-injection quarantine vault (read-only). */
export function urlQuarantineList(
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<UrlAuditResult> {
  return runPrometheus<UrlAuditResult>(["skills", "audit", "--list-quarantine"], opts, config);
}

/** Re-instate a quarantined source from its vault dir (reverses the quarantine). */
export function urlQuarantineRestore(
  vaultDir: string,
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<UrlAuditResult> {
  return runPrometheus<UrlAuditResult>(["skills", "audit", "--restore", vaultDir], opts, config);
}
