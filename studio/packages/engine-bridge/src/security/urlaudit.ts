// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
  /** the engine's REAL payload: one row per source, with a `status` field. */
  skills?: Array<Record<string, unknown>>;
  /** the engine's REAL count map, keyed by status. */
  summary?: Record<string, number>;
}

/**
 * Re-scan installed sources. `quarantine:false` (default for a passive UI refresh)
 * detects + reports drift without mutating; `quarantine:true` performs the
 * fail-closed quarantine+restore + reversible disable of dangerous sources.
 */
export async function urlSourceAudit(
  opts: RunOptions & { quarantine?: boolean } = {},
  config: EngineConfig = {},
): Promise<UrlAuditResult> {
  const argv = ["skills", "audit"];
  if (!opts.quarantine) argv.push("--no-quarantine");
  const env = await runPrometheus<UrlAuditResult>(argv, opts, config);
  return env.result ? env : { ...env, result: groupSkillsByStatus(env) };
}

/**
 * Derive the grouped `result` the UI renders from the FLAT `skills[]` the engine emits.
 *
 * `result` is not a field `prometheus.py skills audit` has ever produced. Its real envelope is
 * `{command, ok, summary:{new,clean,drifted,quarantined,missing,errors}, skills:[{path,status,
 * verdict,reasons,files}], _exit}` — measured on this machine: 45 sources, 27 clean, 18 missing.
 * So `result` was always `undefined`, the Security console's URL-injection panel rendered
 * NOTHING after a full scan — no counts, no quarantined list, no error — and the one thing that
 * surface exists to show was invisible.
 *
 * Grouping here rather than in the renderer keeps every consumer (the desktop panel today, the
 * CLI tomorrow) reading one shape.
 */
export function groupSkillsByStatus(env: UrlAuditResult): NonNullable<UrlAuditResult["result"]> {
  const out: NonNullable<UrlAuditResult["result"]> = {
    new: [],
    clean: [],
    repinned: [],
    quarantined: [],
    missing: [],
    errors: [],
  };
  const rows = Array.isArray(env.skills) ? (env.skills as Record<string, unknown>[]) : [];
  for (const row of rows) {
    const path = typeof row.path === "string" ? row.path : "";
    const status = typeof row.status === "string" ? row.status : "";
    const verdict = typeof row.verdict === "string" ? row.verdict : "";
    if (!path) continue;
    switch (status) {
      case "new":
        out.new.push({ path, kind: String(row.kind ?? ""), verdict, urls: Number(row.urls ?? 0) });
        break;
      case "clean":
        out.clean.push(path);
        break;
      // the engine calls it "drifted"; the UI has always called the bucket "repinned".
      case "drifted":
      case "repinned":
        out.repinned.push({ path, kind: String(row.kind ?? ""), verdict });
        break;
      case "quarantined":
        out.quarantined.push({
          original: typeof row.original === "string" ? row.original : path,
          vault: String(row.vault ?? path),
          verdict,
          ...(typeof row.restored_blessed === "boolean"
            ? { restored_blessed: row.restored_blessed }
            : {}),
          ...(typeof row.first_seen === "boolean" ? { first_seen: row.first_seen } : {}),
        });
        break;
      case "missing":
        out.missing.push(path);
        break;
      default:
        // "error", or a status added later — reported rather than dropped.
        out.errors.push({
          path,
          error: typeof row.error === "string" ? row.error : status || "unknown status",
        });
    }
  }
  return out;
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
