/**
 * security/trust.ts — Audit Log, Trusted Sources, Verify (file 03 §8).
 *
 * Two READ-ONLY views backed by on-disk engine artifacts (honest even if Studio
 * crashed mid-install) plus the trust Revoke and the verdict Verify actions.
 * On-disk reads use node:fs ONLY (stdlib — allowed in engine-bridge/core); the
 * Revoke/Verify spawns go through the existing runners (the only spawners — C5).
 *
 * GROUND TRUTH — probed against the REAL engine:
 *   - TRUST STORE: ~/.config/prometheus/trust.json — a flat object keyed
 *     `<name>@<agent>#<ident>` (the engine's `nemesis:<label>#<ident>` where the
 *     label is `<plugin>@<agent>`). Real sample key:
 *       "superpowers@claude#dir:722971825205"
 *     value: {source, verdict, approvedBy}. `revoke_trust(name)` (prometheus.py
 *     8872) drops every key starting with `<name>@`. So Revoke maps to
 *     `prometheus.py audit <name> --revoke`.
 *   - AUDIT LOG: ~/.nemesis/gate-audit.jsonl — append-only JSONL. Each line:
 *     {at,label,target,verdict,risk_score,blocking_reasons,decision,tier,
 *      gate_mode,verdict_full[,dry_run]} (prometheus.py _gate_audit, 2408).
 *     `verdict_full` is the canonical signed object for `nemesis verify`.
 *   - VERIFY: `nemesis verify <file>` — exit 0 valid · 1 invalid/missing sig ·
 *     2 cannot-read. The signature covers a canonical subset; editing
 *     signature.value flips it to exit 1.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EngineConfig } from "../config.js";
import { type EngineEnvelope, runPrometheus } from "../run.js";
import { type RunOptions, runNemesis } from "./gate.js";

/** ~/.config/prometheus/trust.json */
function trustFilePath(): string {
  return join(homedir(), ".config", "prometheus", "trust.json");
}

/** ~/.nemesis/gate-audit.jsonl */
function auditLogPath(): string {
  return join(homedir(), ".nemesis", "gate-audit.jsonl");
}

export interface TrustedSource {
  /** the full trust-store key, e.g. "superpowers@claude#dir:7229..." */
  key: string;
  /** the plugin name (before "@"). */
  name: string;
  /** the agent (between "@" and "#"), if present. */
  agent: string;
  /** the pinned identity (after "#"): git HEAD sha / tree:<hash> / content shape. */
  ident: string;
  /** where it was approved from (engine `source`). */
  source?: string;
  /** the approved verdict/severity token (engine `verdict`). */
  verdict?: string;
  /** who approved it: "user" | "--yes" (engine `approvedBy`). */
  approvedBy?: string;
}

/**
 * Read the trust store and parse its `<name>@<agent>#<ident>` entries.
 * FAIL-SOFT: a missing / unreadable / malformed file ⇒ [] (never throws). An
 * empty trust list is the correct, safe state — it just means nothing is
 * pre-approved and every install re-prompts.
 */
export function listTrusted(filePath: string = trustFilePath()): TrustedSource[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return []; // file absent ⇒ nothing trusted (fail-soft).
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];

  const out: TrustedSource[] = [];
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    // Key shape: <name>@<agent>#<ident>  (agent/ident optional, parse leniently).
    const hashIdx = key.indexOf("#");
    const head = hashIdx === -1 ? key : key.slice(0, hashIdx);
    const ident = hashIdx === -1 ? "" : key.slice(hashIdx + 1);
    const atIdx = head.indexOf("@");
    const name = atIdx === -1 ? head : head.slice(0, atIdx);
    const agent = atIdx === -1 ? "" : head.slice(atIdx + 1);

    const entry: TrustedSource = { key, name, agent, ident };
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const v = val as Record<string, unknown>;
      if (typeof v.source === "string") entry.source = v.source;
      if (typeof v.verdict === "string") entry.verdict = v.verdict;
      if (typeof v.approvedBy === "string") entry.approvedBy = v.approvedBy;
    }
    out.push(entry);
  }
  return out;
}

export interface RevokeResult {
  ok: boolean;
  name: string;
  envelope?: EngineEnvelope;
  error?: string;
}

/**
 * Revoke remembered trust for a source (`prometheus.py audit <name> --revoke`)
 * so the next install re-prompts (§8). FAIL-CLOSED: a transport failure ⇒
 * ok:false (the trust state is unchanged, which is the safe direction).
 */
export async function revoke(
  name: string,
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<RevokeResult> {
  if (!name?.trim()) return { ok: false, name: name ?? "", error: "empty name" };
  try {
    const env = await runPrometheus<EngineEnvelope>(["audit", name, "--revoke"], opts, config);
    return {
      ok: env.ok !== false,
      name,
      envelope: env,
      error: env.ok === false ? env.error : undefined,
    };
  } catch (e) {
    return { ok: false, name, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One parsed gate-audit.jsonl row. */
export interface AuditLogEntry {
  at: string;
  label: string;
  target: string;
  verdict: string;
  risk_score: number | null;
  blocking_reasons: string[];
  /** "proceed" | "refuse" | "proceed-forced-danger" | null. */
  decision: string | null;
  tier: string;
  gate_mode?: string;
  dry_run?: boolean;
  /** the canonical signed object (`nemesis verify` consumes this). */
  verdict_full?: Record<string, unknown>;
}

export interface AuditLogFilter {
  /** only rows where a BLOCK was forced (decision === "proceed-forced-danger"). */
  forcedDanger?: boolean;
  /** only block / error verdicts. */
  blocks?: boolean;
  /** only rows from the last 24 hours (by `at`). */
  last24h?: boolean;
  /** CLI-079: case-sensitive substring match against `entry.target`. */
  target?: string;
  /** CLI-079: lower bound (inclusive). A bare `YYYY-MM-DD` is UTC-midnight; malformed ⇒ no bound. */
  since?: string;
  /** CLI-079: upper bound (inclusive). A bare `YYYY-MM-DD` is END-OF-DAY UTC; malformed ⇒ no bound. */
  until?: string;
  /** CLI-079: substring match against `blocking_reasons` joined AND the `verdict_full` blob. */
  rule?: string;
}

const FORCED = "proceed-forced-danger";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve `since` to an inclusive epoch-ms lower bound (bare date ⇒ UTC midnight); NaN ⇒ undefined. */
function sinceMs(s?: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(DATE_ONLY.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(t) ? undefined : t;
}

/** Resolve `until` to an inclusive epoch-ms upper bound (bare date ⇒ END-OF-DAY UTC); NaN ⇒ undefined. */
function untilMs(s?: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(DATE_ONLY.test(s) ? `${s}T23:59:59.999Z` : s);
  return Number.isNaN(t) ? undefined : t;
}

/** The RESOLVED time bounds a filter applies (for `--json` echo). `null` ⇒ no/invalid bound. */
export function auditBounds(f: AuditLogFilter): { sinceMs: number | null; untilMs: number | null } {
  return { sinceMs: sinceMs(f.since) ?? null, untilMs: untilMs(f.until) ?? null };
}

function rowMatches(e: AuditLogEntry, f: AuditLogFilter, now: number): boolean {
  if (f.forcedDanger && e.decision !== FORCED) return false;
  if (f.blocks && e.verdict !== "block" && e.verdict !== "error") return false;
  // time filters share one parse of `at`; a malformed `at` fails ANY bounded query (fail-soft).
  const t = Date.parse(e.at);
  if (f.last24h && (!Number.isFinite(t) || now - t > 24 * 3600 * 1000)) return false;
  const lo = sinceMs(f.since);
  const hi = untilMs(f.until);
  if (lo !== undefined && (!Number.isFinite(t) || t < lo)) return false;
  if (hi !== undefined && (!Number.isFinite(t) || t > hi)) return false;
  if (f.target && !e.target.includes(f.target)) return false;
  if (f.rule) {
    const hay =
      e.blocking_reasons.join("\n") + (e.verdict_full ? `\n${JSON.stringify(e.verdict_full)}` : "");
    if (!hay.includes(f.rule)) return false;
  }
  return true;
}

function parseAuditRow(line: string): AuditLogEntry | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null; // skip a corrupt line, don't fail the whole read.
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  return {
    at: typeof r.at === "string" ? r.at : "",
    label: typeof r.label === "string" ? r.label : "",
    target: typeof r.target === "string" ? r.target : "",
    verdict: typeof r.verdict === "string" ? r.verdict : "error",
    risk_score: typeof r.risk_score === "number" ? r.risk_score : null,
    blocking_reasons: Array.isArray(r.blocking_reasons)
      ? r.blocking_reasons.filter((x): x is string => typeof x === "string")
      : [],
    decision: typeof r.decision === "string" ? r.decision : null,
    tier: typeof r.tier === "string" ? r.tier : "default",
    gate_mode: typeof r.gate_mode === "string" ? r.gate_mode : undefined,
    dry_run: r.dry_run === true ? true : undefined,
    verdict_full:
      r.verdict_full && typeof r.verdict_full === "object" && !Array.isArray(r.verdict_full)
        ? (r.verdict_full as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Read the gate-audit log NEWEST-FIRST with optional filters (§8). FAIL-SOFT: a
 * missing / unreadable file ⇒ [] (never throws); corrupt lines are skipped.
 */
export function auditLog(
  filter: AuditLogFilter = {},
  filePath: string = auditLogPath(),
): AuditLogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const now = Date.now();
  const out: AuditLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const entry = parseAuditRow(t);
    if (entry && rowMatches(entry, filter, now)) out.push(entry);
  }
  // newest-first: the file is append-only (oldest first), so reverse.
  out.reverse();
  return out;
}

export interface VerifyResult {
  /** true ONLY on exit 0. exit 1 (invalid/missing sig) or 2 (unreadable) ⇒ false. */
  valid: boolean;
  /** the engine's one-line result message. */
  message: string;
  exitCode: number;
}

/**
 * Verify an HMAC-signed verdict file (`nemesis verify <file>`): exit 0 valid ·
 * 1 invalid/missing · 2 cannot-read. Tamper ⇒ non-zero ⇒ {valid:false}.
 * FAIL-CLOSED: a spawn failure / missing binary ⇒ {valid:false} (never throws).
 */
export async function verify(
  file: string,
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<VerifyResult> {
  if (!file?.trim()) return { valid: false, message: "no file given", exitCode: 2 };
  try {
    const res = await runNemesis(["verify", file], opts, config);
    return {
      valid: res.exitCode === 0,
      message: (res.stdout.trim() || res.stderr.trim()).trim(),
      exitCode: res.exitCode,
    };
  } catch (e) {
    return { valid: false, message: e instanceof Error ? e.message : String(e), exitCode: 2 };
  }
}
