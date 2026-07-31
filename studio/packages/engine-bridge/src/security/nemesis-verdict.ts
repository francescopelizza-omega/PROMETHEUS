/**
 * security/nemesis-verdict.ts — the FULL `nemesis.verdict/1` mirror (file 03 §3).
 *
 * RECONCILIATION (do not break the C3 cross-package contract):
 *   verdict.ts owns the LIGHTWEIGHT canonical `SecurityVerdict` / `Finding` that
 *   core / cli / tests depend on. THIS module owns the RICH, 1:1 mirror of the
 *   real engine JSON (schema "nemesis.verdict/1") that the security UI renders.
 *   They never collide: `NemesisVerdict` ≠ `SecurityVerdict`, `NemesisFinding` ≠
 *   `Finding`. gate() stays a lightweight projection; gateFull() returns this.
 *
 * GROUND TRUTH — captured from the REAL `nemesis 1.12.0`:
 *   `nemesis gate <path>` → exactly one nemesis.verdict/1 object on stdout, exit
 *   0 allow / 10 warn / 20 block / 2 error. The fields below are the ACTUAL keys
 *   the binary emits (probed 2026-06-16), NOT the idealized §3 sketch:
 *     - findings_by_class is Record<klass, NemesisFinding[]>  (arrays, NOT counts)
 *     - class_counts      is Record<klass, number>            (the counts live here)
 *     - a finding is {path,line,column,rule_id,rule,category,severity,class,
 *                     action,description,remediation,snippet}
 *       => `detail` is `description`, `klass` is `class`, there is NO `remediable`
 *          field (we DERIVE it: action ∈ neutralize|remove|fix ⇒ remediable, and
 *          in-archive members "x.zip!member" are NEVER remediable — §3, §9.1).
 *     - provenance carries {ruleset_sha, indicators_loaded, db:{seeded,age_days,
 *       stale}, findings_ignored, files_scanned, sca_unscanned_ecosystems,
 *       extract_tier}.  There is NO `feeds` map in the verdict (feeds live in
 *       `nemesis update --list`).
 *     - the signature rides at TOP LEVEL as `signature:{alg,value,key_id}` when
 *       `--sign` is passed (NOT as `signed:{hmac}` — that was the §3 sketch).
 *     - `cached:true` is present ONLY on a cache hit; absent on a fresh scan.
 *     - blind spots surface as `unscannable:boolean` (+ per-finding klass
 *       "container"); there is no `blind_spots[]` array in this build.
 *
 * GOLDEN RULE (C5): NOTHING here scores, allowlists, or heuristically decides
 * "safe". parseNemesisVerdict only MIRRORS engine output and fills defensible
 * defaults for fields a given nemesis build omits — it NEVER throws and NEVER
 * upgrades a verdict toward allow.
 */

import type { VerdictTier } from "./verdict.js";

/** The decision axis, mirrored verbatim from the engine (allow|warn|block|error). */
export type NemesisVerdictLevel = VerdictTier;

/** The raw severity token the engine emits on every finding. */
export type NemesisSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

/**
 * The verdict-class buckets (deep-coverage P7.0). The engine emits these as the
 * `class` field and as the keys of findings_by_class / class_counts. We keep an
 * open string union fallback so a NEW class from a future build never crashes us.
 */
export type NemesisKlass = "malware" | "secret" | "vuln" | "sca" | "container" | (string & {});

/** The keys the engine uses for severity_counts. */
export type SeverityCounts = Record<NemesisSeverity, number>;

/**
 * One rich finding — a 1:1 mirror of the engine's finding object PLUS a derived
 * `remediable` flag (the engine carries `action`/`remediation` instead). Every
 * string field is rendered as INERT TEXT by the UI (file 03 §2.1) — never HTML.
 */
export interface NemesisFinding {
  rule_id: string;
  /** human-friendly rule name (engine `rule`), e.g. "curl|wget piped to shell". */
  rule?: string;
  severity: NemesisSeverity;
  klass: NemesisKlass;
  /** engine `category`, e.g. "dropper" / "supply_chain". */
  category?: string;
  /** logical path; "pkg.tar.gz!setup.py" for in-archive members. */
  path: string;
  line?: number;
  column?: number;
  /** engine `description` — the human reason. Rendered as TEXT, never HTML. */
  detail: string;
  /** engine `remediation` advice (how to fix), if any. */
  remediation?: string;
  snippet?: string;
  /** engine remediation `action`: neutralize|quarantine|remove|none|… */
  action?: string;
  /**
   * DERIVED, not emitted: can Disinfect fix it in place? True when the engine's
   * action is a line-level neutralization AND the finding is not inside an
   * archive (in-archive members can NEVER be edited in place — §3, §9.1).
   */
  remediable: boolean;
}

/** Per-class finding lists, exactly as the engine groups them. */
export type FindingsByClass = Partial<Record<NemesisKlass, NemesisFinding[]>>;

/** The engine's per-class COUNT map (separate from findings_by_class). */
export type ClassCounts = Partial<Record<NemesisKlass, number>>;

/** The signature block the engine attaches under `--sign`. */
export interface NemesisSignature {
  alg: string; // "HMAC-SHA256"
  value: string; // the HMAC hex
  key_id: string;
}

/** What the engine reports loaded into the signature DB (provenance.indicators_loaded). */
export interface IndicatorsLoaded {
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

/** The signature-DB freshness sub-block that drives the §6 DB banner. */
export interface DbProvenance {
  seeded: boolean;
  age_days: number;
  stale: boolean;
}

/** The verdict's full provenance block (the honesty surface — §6, §11). */
export interface NemesisProvenance {
  ruleset_sha: string;
  indicators_loaded: IndicatorsLoaded;
  db: DbProvenance;
  findings_ignored: number;
  files_scanned: number;
  sca_unscanned_ecosystems: string[];
  /** "none" | "stream" | "jail" | "rlimit" | "extract" — how archives were opened. */
  extract_tier?: string;
}

/** safe_to triad — the engine's bottom-line capability answer. */
export interface SafeTo {
  install: boolean;
  run_plug_and_play: boolean;
  use_as_ai_cli_agent: boolean;
}

/**
 * The disinfection summary the engine attaches after a `--fix`/`--disinfect` run.
 * GROUND TRUTH (probed nemesis 1.12.0): the engine reports resolved/unresolved as
 * RULE-ID arrays (not finding objects), plus the cleaned-copy `output` dir.
 */
export interface DisinfectionReport {
  applied: boolean;
  neutralized_lines: number;
  quarantined_files: number;
  /** rule-ids the disinfect run resolved (line neutralized / file quarantined). */
  resolved_rules: string[];
  /** rule-ids that could NOT be auto-fixed (hard malware / in-archive). */
  unresolved_rules: string[];
  errors: string[];
  /** the cleaned-copy directory (mirrors `--out`). */
  output: string;
  [k: string]: unknown;
}

/**
 * The full nemesis.verdict/1 object. A 1:1 typed mirror — authored ONLY by
 * parseNemesisVerdict at the bridge boundary, never hand-edited field by field.
 */
export interface NemesisVerdict {
  schema: "nemesis.verdict/1";
  tool: string; // "nemesis"
  tool_version: string;
  target: string;
  target_kind: string; // "dir" | "file" | "repo" | "archive" | "url" | "stdin" | …
  target_sha256: string | null;
  scanned_at: string;
  duration_s: number;
  verdict: NemesisVerdictLevel;
  risk_score: number; // 0–100
  exit_code: number; // 0 | 10 | 20 | 2
  severity_counts: SeverityCounts;
  class_counts: ClassCounts;
  findings_by_class: FindingsByClass;
  safe_to: SafeTo;
  recommendation: string;
  blocking_reasons: string[];
  top_findings: NemesisFinding[];
  unscannable: boolean;
  disinfection: DisinfectionReport | null;
  provenance: NemesisProvenance;
  policy: string; // "default" | "pentest" | <custom>
  host: string;
  /** present ONLY on a verdict cache hit. */
  cached: boolean;
  /** present ONLY when `--sign` was passed; the audit-log Verify feature uses it. */
  signature?: NemesisSignature;
}

/**
 * The `forced_danger` block — the post-install red-ribbon source (§5.4). This is
 * the RICH variant; verdict.ts keeps the lightweight `ForcedDanger` used by the
 * install envelope path.
 */
export interface ForcedDangerFull {
  label: string;
  verdict: "block" | "error";
  risk_score: number;
  blocking_reasons: string[];
}

/** A single install lifecycle event (mirrors the prometheus.py install envelope). */
export interface InstallEventLite {
  agent?: string;
  status?: string;
  [k: string]: unknown;
}

/**
 * The prometheus.py `--json install` envelope, narrowed to the fields the
 * security UI reads. `forced_danger` present ⇒ ok:false ⇒ render the red ribbon.
 */
export interface InstallEnvelope {
  ok: boolean;
  command: "install";
  results?: {
    install_events?: InstallEventLite[];
    summary?: Record<string, unknown>;
  };
  forced_danger?: ForcedDangerFull[];
  [k: string]: unknown;
}

// --------------------------------------------------------------------------
// Parsing — tolerant, never-throwing, fail-closed-by-construction.
// --------------------------------------------------------------------------

const ZERO_SEVERITY_COUNTS: SeverityCounts = {
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
  INFO: 0,
};

const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

const asString = (x: unknown, fallback = ""): string => (typeof x === "string" ? x : fallback);

const asNumber = (x: unknown, fallback = 0): number =>
  typeof x === "number" && Number.isFinite(x) ? x : fallback;

const asBool = (x: unknown, fallback = false): boolean => (typeof x === "boolean" ? x : fallback);

const asStringArray = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];

/** Canonicalise an engine verdict token; fail-closed to "error" on anything odd. */
function normLevel(raw: unknown): NemesisVerdictLevel {
  const v = asString(raw).trim().toLowerCase();
  if (v === "allow" || v === "warn" || v === "block" || v === "error") return v;
  return "error";
}

/** Canonicalise a severity token; unknown ⇒ "INFO" (it is still surfaced as a finding). */
function normSeverity(raw: unknown): NemesisSeverity {
  const s = asString(raw).trim().toUpperCase();
  if (s === "CRITICAL" || s === "HIGH" || s === "MEDIUM" || s === "LOW" || s === "INFO") {
    return s;
  }
  return "INFO";
}

/** Is this logical path an in-archive member? Those can NEVER be remediated in place. */
function isInArchive(path: string): boolean {
  return path.includes("!");
}

/**
 * Derive `remediable` the way the disinfect workflow needs it (§9.1):
 *   - in-archive members are NEVER remediable (cannot edit in place);
 *   - otherwise, a line-level neutralize/remove/fix action is remediable.
 * If the engine ever ships an explicit `remediable` boolean, honour it verbatim.
 */
function deriveRemediable(o: Record<string, unknown>, path: string): boolean {
  if (typeof o.remediable === "boolean") return o.remediable && !isInArchive(path);
  if (isInArchive(path)) return false;
  const action = asString(o.action).trim().toLowerCase();
  return action === "neutralize" || action === "remove" || action === "fix";
}

/** Parse one finding object into a NemesisFinding. Never throws; fills defaults. */
export function parseNemesisFinding(raw: unknown): NemesisFinding {
  const o = isObject(raw) ? raw : {};
  const path = asString(o.path);
  const finding: NemesisFinding = {
    rule_id: asString(o.rule_id, "UNKNOWN"),
    severity: normSeverity(o.severity),
    klass: asString(o.class, "malware"),
    path,
    detail: asString(o.description),
    remediable: deriveRemediable(o, path),
  };
  const rule = asString(o.rule);
  if (rule) finding.rule = rule;
  const category = asString(o.category);
  if (category) finding.category = category;
  if (typeof o.line === "number") finding.line = o.line;
  if (typeof o.column === "number") finding.column = o.column;
  const remediation = asString(o.remediation);
  if (remediation) finding.remediation = remediation;
  const snippet = asString(o.snippet);
  if (snippet) finding.snippet = snippet;
  const action = asString(o.action);
  if (action) finding.action = action;
  return finding;
}

function parseFindingArray(raw: unknown): NemesisFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseNemesisFinding);
}

function parseSeverityCounts(raw: unknown): SeverityCounts {
  if (!isObject(raw)) return { ...ZERO_SEVERITY_COUNTS };
  return {
    CRITICAL: asNumber(raw.CRITICAL),
    HIGH: asNumber(raw.HIGH),
    MEDIUM: asNumber(raw.MEDIUM),
    LOW: asNumber(raw.LOW),
    INFO: asNumber(raw.INFO),
  };
}

function parseClassCounts(raw: unknown): ClassCounts {
  if (!isObject(raw)) return {};
  const out: ClassCounts = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function parseFindingsByClass(raw: unknown): FindingsByClass {
  if (!isObject(raw)) return {};
  const out: FindingsByClass = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = parseFindingArray(v);
  }
  return out;
}

function parseProvenance(raw: unknown): NemesisProvenance {
  const o = isObject(raw) ? raw : {};
  const db = isObject(o.db) ? o.db : {};
  const indicators = isObject(o.indicators_loaded) ? (o.indicators_loaded as IndicatorsLoaded) : {};
  const prov: NemesisProvenance = {
    ruleset_sha: asString(o.ruleset_sha),
    indicators_loaded: indicators,
    db: {
      // A MISSING/unparseable db block must read as NOT seeded + stale, never
      // as a healthy DB — the §6 banner is a safety surface, fail toward warning.
      seeded: asBool(db.seeded, false),
      age_days: asNumber(db.age_days, 0),
      stale: typeof db.stale === "boolean" ? db.stale : true,
    },
    findings_ignored: asNumber(o.findings_ignored),
    files_scanned: asNumber(o.files_scanned),
    sca_unscanned_ecosystems: asStringArray(o.sca_unscanned_ecosystems),
  };
  const extractTier = asString(o.extract_tier);
  if (extractTier) prov.extract_tier = extractTier;
  return prov;
}

function parseSafeTo(raw: unknown): SafeTo {
  const o = isObject(raw) ? raw : {};
  // Default-deny: a missing safe_to block must NOT read as "safe to install".
  return {
    install: asBool(o.install, false),
    run_plug_and_play: asBool(o.run_plug_and_play, false),
    use_as_ai_cli_agent: asBool(o.use_as_ai_cli_agent, false),
  };
}

function parseSignature(raw: unknown): NemesisSignature | undefined {
  if (!isObject(raw)) return undefined;
  const value = asString(raw.value);
  if (!value) return undefined;
  return {
    alg: asString(raw.alg, "HMAC-SHA256"),
    value,
    key_id: asString(raw.key_id),
  };
}

function parseDisinfection(raw: unknown): DisinfectionReport | null {
  if (!isObject(raw)) return null;
  const known = new Set([
    "applied",
    "neutralized_lines",
    "quarantined_files",
    "resolved_rules",
    "unresolved_rules",
    "errors",
    "output",
  ]);
  const report: DisinfectionReport = {
    applied: asBool(raw.applied, false),
    neutralized_lines: asNumber(raw.neutralized_lines),
    quarantined_files: asNumber(raw.quarantined_files),
    resolved_rules: asStringArray(raw.resolved_rules),
    unresolved_rules: asStringArray(raw.unresolved_rules),
    errors: asStringArray(raw.errors),
    output: asString(raw.output),
  };
  // Carry any extra engine fields through untouched (rendered, not interpreted).
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) report[k] = v;
  }
  return report;
}

/**
 * Parse ANY value that should be a nemesis.verdict/1 object into a fully-typed
 * NemesisVerdict. TOLERANT: missing fields get DEFENSIBLE, fail-closed-leaning
 * defaults (no safe_to, no db, stale-by-default). NEVER throws. If the input is
 * not an object at all, returns a synthetic ERROR verdict (fail-closed BLOCK).
 */
export function parseNemesisVerdict(raw: unknown, target = ""): NemesisVerdict {
  if (!isObject(raw)) {
    return syntheticErrorVerdict(target, "non-object nemesis output");
  }
  const o = raw;
  const verdict = normLevel(o.verdict);
  const exit = asNumber(o.exit_code, verdict === "allow" ? 0 : verdict === "warn" ? 10 : 20);

  const out: NemesisVerdict = {
    schema: "nemesis.verdict/1",
    tool: asString(o.tool, "nemesis"),
    tool_version: asString(o.tool_version),
    target: asString(o.target, target),
    target_kind: asString(o.target_kind, "unknown"),
    target_sha256: typeof o.target_sha256 === "string" ? o.target_sha256 : null,
    scanned_at: asString(o.scanned_at, new Date().toISOString()),
    duration_s: asNumber(o.duration_s),
    verdict,
    risk_score: asNumber(o.risk_score, verdict === "allow" ? 0 : 100),
    exit_code: exit,
    severity_counts: parseSeverityCounts(o.severity_counts),
    class_counts: parseClassCounts(o.class_counts),
    findings_by_class: parseFindingsByClass(o.findings_by_class),
    safe_to: parseSafeTo(o.safe_to),
    recommendation: asString(o.recommendation),
    blocking_reasons: asStringArray(o.blocking_reasons),
    top_findings: parseFindingArray(o.top_findings),
    unscannable: asBool(o.unscannable, false),
    disinfection: parseDisinfection(o.disinfection),
    provenance: parseProvenance(o.provenance),
    policy: asString(o.policy, "default"),
    host: asString(o.host),
    cached: asBool(o.cached, false),
  };
  const signature = parseSignature(o.signature);
  if (signature) out.signature = signature;
  return out;
}

/**
 * The synthetic fail-closed verdict (verdict "error", risk 100, safe_to all
 * false). Returned whenever a trustworthy verdict cannot be obtained — missing
 * binary, spawn failure, timeout, or unparseable output (C5: error ⇒ BLOCK).
 */
export function syntheticErrorVerdict(target: string, reason: string): NemesisVerdict {
  const finding: NemesisFinding = {
    rule_id: "NEMESIS-UNAVAILABLE",
    rule: "scanner did not return a verdict",
    severity: "CRITICAL",
    klass: "malware",
    path: target || "(unknown)",
    detail: `nemesis could not produce a verdict (fail-closed BLOCK): ${reason}`,
    remediable: false,
  };
  return {
    schema: "nemesis.verdict/1",
    tool: "nemesis",
    tool_version: "",
    target,
    target_kind: "unknown",
    target_sha256: null,
    scanned_at: new Date().toISOString(),
    duration_s: 0,
    verdict: "error",
    risk_score: 100,
    exit_code: 2,
    severity_counts: { ...ZERO_SEVERITY_COUNTS, CRITICAL: 1 },
    class_counts: { malware: 1 },
    findings_by_class: { malware: [finding] },
    safe_to: { install: false, run_plug_and_play: false, use_as_ai_cli_agent: false },
    recommendation: "Scanner unavailable — treat as UNSAFE. Refuse (fail-closed).",
    blocking_reasons: [`scanner failure: ${reason}`],
    top_findings: [finding],
    unscannable: true,
    disinfection: null,
    provenance: {
      ruleset_sha: "",
      indicators_loaded: {},
      db: { seeded: false, age_days: 0, stale: true },
      findings_ignored: 0,
      files_scanned: 0,
      sca_unscanned_ecosystems: [],
    },
    policy: "default",
    host: "",
    cached: false,
  };
}
