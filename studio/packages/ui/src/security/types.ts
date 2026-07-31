/**
 * security/types.ts — the renderer-facing data shapes the §4–§9 security
 * components render, as @prometheus/ui-LOCAL structural mirrors.
 *
 * WHY MIRRORED HERE (not imported): @prometheus/ui is a sandboxed presentational
 * package (C5). It may import ONLY `react` + its own modules — it may NOT import
 * `@prometheus/engine-bridge` (biome-enforced) and it has no project reference to
 * `@prometheus/core`, so a cross-package type import would not even resolve under
 * `tsc -b`. Instead, these interfaces are STRUCTURAL mirrors of the engine-bridge
 * `NemesisVerdict` / `NemesisFinding` / `ThreatDbStatus` / `TrustedSource` /
 * `AuditLogEntry` / remediation shapes (probed against nemesis 1.12.0). Because
 * they are structural, the renderer (which DOES depend on both packages) passes a
 * real engine-bridge `NemesisVerdict` straight into these props with no adapter —
 * structural typing makes them assignment-compatible.
 *
 * GOLDEN RULE (C5): these are DISPLAY shapes only. The components that consume
 * them NEVER score, allowlist, or decide "safe" — they render a verdict the
 * Python engine already computed and accept every decision callback as a prop.
 */

/** The decision axis — mirrors nemesis exit tiers 0/10/20/2 (C3). */
export type SecVerdictTier = "allow" | "warn" | "block" | "error";

/** The raw severity token the engine emits on every finding. */
export type SecSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

/**
 * One rich finding — a structural mirror of engine-bridge `NemesisFinding`. Every
 * string field is rendered as INERT TEXT (§2.1): a `<pre>`, ANSI-stripped, never
 * HTML. `klass` is an open string union so a new verdict-class never crashes us.
 */
export interface SecFinding {
  rule_id: string;
  rule?: string;
  severity: SecSeverity;
  klass: string;
  category?: string;
  path: string;
  line?: number;
  column?: number;
  /** the human reason (engine `description`). Rendered as TEXT, never HTML. */
  detail: string;
  remediation?: string;
  snippet?: string;
  action?: string;
  /** DERIVED upstream: can Disinfect fix it in place? in-archive ⇒ never. */
  remediable: boolean;
}

/** The signature-DB freshness sub-block (drives the §6 banner). */
export interface SecDbProvenance {
  seeded: boolean;
  age_days: number;
  stale: boolean;
}

/** What the engine reports loaded into the signature DB. */
export interface SecIndicatorsLoaded {
  sha256?: number;
  sha1?: number;
  md5?: number;
  domains?: number;
  urls?: number;
  ips?: number;
  clamav_ndb?: number;
  kev_cves?: number;
  [k: string]: number | undefined;
}

/** The verdict's provenance block (the honesty surface — §6, §11). */
export interface SecProvenance {
  ruleset_sha: string;
  indicators_loaded: SecIndicatorsLoaded;
  db: SecDbProvenance;
  findings_ignored: number;
  files_scanned: number;
  sca_unscanned_ecosystems: string[];
  extract_tier?: string;
}

/** safe_to triad — the engine's bottom-line capability answer. */
export interface SecSafeTo {
  install: boolean;
  run_plug_and_play: boolean;
  use_as_ai_cli_agent: boolean;
}

/** The HMAC signature block the engine attaches under `--sign`. */
export interface SecSignature {
  alg: string;
  value: string;
  key_id: string;
}

/**
 * The full nemesis.verdict/1 object — a structural mirror of engine-bridge
 * `NemesisVerdict`. Authored upstream by parseNemesisVerdict; rendered here.
 */
export interface SecVerdict {
  schema: "nemesis.verdict/1";
  tool: string;
  tool_version: string;
  target: string;
  target_kind: string;
  target_sha256: string | null;
  scanned_at: string;
  duration_s: number;
  verdict: SecVerdictTier;
  risk_score: number;
  exit_code: number;
  severity_counts: Record<SecSeverity, number>;
  class_counts: Partial<Record<string, number>>;
  findings_by_class: Partial<Record<string, SecFinding[]>>;
  safe_to: SecSafeTo;
  recommendation: string;
  blocking_reasons: string[];
  top_findings: SecFinding[];
  unscannable: boolean;
  disinfection: unknown;
  provenance: SecProvenance;
  policy: string;
  host: string;
  cached: boolean;
  signature?: SecSignature;
}

/**
 * The display descriptor the GUI renders a verdict with — a structural mirror of
 * @prometheus/core `VerdictDisplay`. The renderer obtains the REAL one from
 * `verdictDisplay(tier)` (core) and passes it as a prop, so color/label come ONLY
 * from the canonical verdictMapping (file 03 §3 / C5), never from this package.
 */
export interface SecVerdictDisplay {
  /** semantic role — maps to a ui token (`ok`/`warn`/`danger`), never raw hex. */
  color: "ok" | "warn" | "danger";
  /** the UPPERCASE headline label (e.g. "DEEP-RED BLOCK", "REVIEW", "SAFE …"). */
  label: string;
  defaultAction: "proceed" | "hold" | "refuse";
  override: "none" | "install-anyway" | "force";
}

/** The post-install `forced_danger` shape (drives the §5.4 red ribbon). */
export interface SecForcedDanger {
  label: string;
  verdict: "block" | "error";
  risk_score: number;
  blocking_reasons: string[];
  /** when the override was logged (renderer may add it from the audit row). */
  at?: string;
}

/** A trust-store entry — mirror of engine-bridge `TrustedSource` (§8). */
export interface SecTrustedSource {
  key: string;
  name: string;
  agent: string;
  ident: string;
  source?: string;
  verdict?: string;
  approvedBy?: string;
}

/** One parsed gate-audit.jsonl row — mirror of engine-bridge `AuditLogEntry` (§8). */
export interface SecAuditLogEntry {
  at: string;
  label: string;
  target: string;
  verdict: string;
  risk_score: number | null;
  blocking_reasons: string[];
  decision: string | null;
  tier: string;
  gate_mode?: string;
  dry_run?: boolean;
  verdict_full?: Record<string, unknown>;
}

/** The threat-DB status — mirror of engine-bridge `ThreatDbStatus` (§6). */
export interface SecThreatDbStatus {
  ok: boolean;
  db: SecDbProvenance;
  indicators: SecIndicatorsLoaded;
  rulesetSha: string;
  /** true ⇒ raise the global "DB blind" banner (§6). */
  blind: boolean;
  error?: string;
}

/** A single feed row for the §6 feeds list (renderer parses `nemesis update --list`). */
export interface SecFeedStatus {
  id: string;
  label: string;
  /** "●" present · "○" disabled/opt-in · "⚠" needs key — the renderer decides. */
  state: "active" | "optional" | "needs-key" | "stale" | "error";
  /** freshness text, e.g. "fetched 6 h ago". */
  fetched?: string;
  /** count text, e.g. "54,649 hashes". */
  count?: string;
  /** does enabling this feed require the abuse.ch auth key? */
  needsKey?: boolean;
}

/** One quarantined item the vault lists (§9.2). The renderer parses the manifest. */
export interface SecQuarantineItem {
  id: string;
  /** the logical path of the sidelined file ("server/agent.py" or "x.zip!m.bin"). */
  path: string;
  rule_id: string;
  /** ISO timestamp it was quarantined. */
  quarantined_at: string;
  /** the source it came from (e.g. "odysseus"). */
  from?: string;
  sha?: string;
}

/**
 * A finding split into the disinfect wizard's two buckets (§9.1): line-level
 * remediable vs. quarantine-only (hard malware / in-archive). The renderer
 * derives these from a verdict's findings (`finding.remediable`).
 */
export interface SecDisinfectPlan {
  /** findings whose offending line will be neutralized (a `.bak` is kept). */
  remediable: SecFinding[];
  /** findings that can only be QUARANTINED, not fixed in place. */
  quarantineOnly: SecFinding[];
}

/**
 * The result of verifying a signed audit row's HMAC — mirror of engine-bridge
 * `VerifyResult` (§8). `valid` drives the green/red surface; `reason` is the
 * inert-text explanation when invalid.
 */
export interface SecVerifyResult {
  valid: boolean;
  reason?: string;
  key_id?: string;
}

/** The audit-log display filters (§8). All-false ⇒ show everything. */
export interface SecAuditFilter {
  /** only rows where a dangerous override was forced. */
  forcedOnly?: boolean;
  /** only rows whose tier blocked (block/error). */
  blocksOnly?: boolean;
  /** only rows within the last 24 hours. */
  last24h?: boolean;
}
