/**
 * security/util.ts — the two pure guards the inert-text renderer leans on (file 03 §2.1).
 *
 * The renderer treats EVERY engine-sourced string (a finding `detail`, a
 * `snippet`, a model card, a README) as UNTRUSTED TEXT. A malicious source can
 * embed ANSI escapes, control characters, or HTML/markup in those strings. These
 * helpers make such strings safe to drop into a `<pre>` as plain text:
 *
 *   - stripAnsi    removes ANSI/VT escape sequences (CSI/OSC/2-byte) so a snippet
 *                  copied from a TTY-coloured scan renders as clean text. The
 *                  bridge already passes `--no-color`; this is defence in depth —
 *                  a snippet lifted verbatim from a malicious file may still carry
 *                  raw escapes the engine never added.
 *   - inertText    the single funnel every untrusted string passes through before
 *                  it is rendered: strip ANSI AND bare control chars, hand back a
 *                  plain string. The COMPONENT renders it as a React text child
 *                  (`<pre>{inertText(s)}</pre>`), NEVER via dangerouslySetInnerHTML
 *                  and NEVER through a markdown-with-raw-HTML renderer.
 *
 * GOLDEN RULE (C5): NOTHING here decides "safe" — these only sanitise display.
 * They do not parse, score, allowlist, or interpret the text; they make it inert.
 * Both are pure (no DOM, no React) so they unit-test on stdlib node:test.
 *
 * IMPLEMENTATION NOTE: the patterns are built from `String.fromCharCode` + the
 * RegExp constructor so this SOURCE FILE contains NO literal control characters
 * (keeps the file copy-safe and biome-clean; the matching logic is unaffected).
 */

import type {
  SecAuditFilter,
  SecAuditLogEntry,
  SecDisinfectPlan,
  SecFinding,
  SecSeverity,
  SecVerdictDisplay,
  SecVerdictTier,
} from "./types.js";

const ESC = String.fromCharCode(0x1b); // ESC — the lead byte of every ANSI escape.
const BEL = String.fromCharCode(0x07); // BEL — one OSC terminator.

/**
 * ANSI / VT escape sequences, as alternatives (global, every occurrence removed):
 *   - CSI : ESC [ <params 0-9;?> <intermediates space-/> <final @-~>
 *   - OSC : ESC ] <body, no ESC> (BEL | ESC \)        — title/hyperlink strings
 *   - 2-byte : ESC <single @-_ byte>                   — SS2/SS3/ST/charset selects
 */
const ANSI_PATTERN = new RegExp(
  [
    `${ESC}\\[[0-9;?]*[ -/]*[@-~]`,
    `${ESC}\\][^${ESC}${BEL}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[@-Z\\\\-_]`,
  ].join("|"),
  "g",
);

/**
 * Bare control characters that are never meaningful in a finding snippet and are
 * often used to smuggle/obscure bytes past a naive viewer: C0 (0x00–0x08, 0x0B,
 * 0x0C, 0x0E–0x1F), DEL (0x7F), and C1 (0x80–0x9F). TAB (0x09) and LF (0x0A) are
 * intentionally KEPT so a multi-line snippet still wraps in a <pre>.
 */
const CONTROL_PATTERN = new RegExp(
  `[${["\\u0000-\\u0008", "\\u000B", "\\u000C", "\\u000E-\\u001F", "\\u007F-\\u009F"].join("")}]`,
  "g",
);

/**
 * Strip ANSI/VT escape sequences from a string. Returns "" for a non-string.
 * Pure; leaves printable text (incl. unicode) untouched.
 */
export function stripAnsi(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(ANSI_PATTERN, "");
}

/**
 * Make an untrusted engine string safe to render as plain text: strip ANSI escape
 * sequences AND bare control characters (keeping TAB and LF so a multi-line
 * snippet still shows line breaks in a <pre>). The result is a plain string with
 * no markup meaning — the component renders it as a React TEXT child, never HTML.
 *
 * This is the ONLY transform applied to a snippet/detail before display. It does
 * not escape `<`/`&` (React escapes text children itself) and it does not
 * interpret markdown — by design (§2.1: inert text, never markdown-with-raw-HTML).
 */
export function inertText(input: unknown): string {
  if (typeof input !== "string") return "";
  return stripAnsi(input).replace(CONTROL_PATTERN, "");
}

/* ────────────────────────────────────────────────────────────────────────────
 * VERDICT DISPLAY SELECTION (file 03 §3) — a LOCAL, runtime-dep-free mirror of
 * @prometheus/core `verdictMapping`.
 *
 * WHY MIRRORED (not imported): @prometheus/ui is the sandboxed presentational
 * package (C5). It has NO project reference to @prometheus/core and the renderer
 * build aliases ONLY `@prometheus/ui` (electron.vite.config.ts) — a core import
 * would not even resolve. So, exactly like security/types.ts mirrors the
 * engine-bridge SHAPES, this mirrors the core §3 TABLE: the SAME verdict→
 * {color, label, defaultAction, override} map and the SAME needsExplicitApproval
 * rule, byte-for-byte. security.test.ts imports the REAL @prometheus/core (which
 * IS resolvable in the test runner via dev-resolver) and pins this mirror against
 * it, so the two can never drift.
 *
 * GOLDEN RULE (C5): NOTHING here decides "safe". These are PURE lookups keyed on
 * the engine-computed verdict tier + the engine-provided severity counts. No
 * scoring, no risk recompute, no allowlist — an unknown tier fails CLOSED to the
 * UNVERIFIED/refuse descriptor, never to allow.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The §3 table — the verdict→display map. Frozen so a caller can never mutate it.
 * Mirrors core `VERDICT_DISPLAY` verbatim (pinned by security.test.ts).
 */
export const VERDICT_DISPLAY: Readonly<Record<SecVerdictTier, Readonly<SecVerdictDisplay>>> =
  Object.freeze({
    allow: Object.freeze({
      color: "ok",
      label: "SAFE — no known threats found",
      defaultAction: "proceed",
      override: "none",
    }),
    warn: Object.freeze({
      color: "warn",
      label: "REVIEW",
      defaultAction: "hold",
      override: "install-anyway",
    }),
    block: Object.freeze({
      color: "danger",
      label: "DEEP-RED BLOCK",
      defaultAction: "refuse",
      override: "force",
    }),
    error: Object.freeze({
      color: "danger",
      label: "UNVERIFIED",
      defaultAction: "refuse",
      override: "force",
    }),
  });

/**
 * Map a verdict tier to its display descriptor (§3). PURE: a lookup, no scoring.
 * An unknown/garbage tier fails CLOSED to the `error` (UNVERIFIED/refuse)
 * descriptor — never to `allow`. The COMPONENT renders color/label ONLY from here.
 */
export function verdictDisplay(tier: SecVerdictTier): SecVerdictDisplay {
  return VERDICT_DISPLAY[tier] ?? VERDICT_DISPLAY.error;
}

/** Map a verdict display `color` role to its CSS-var (`ok`/`warn`/`danger`). */
export function roleVar(role: SecVerdictDisplay["color"]): string {
  return `var(--${role})`;
}

/**
 * The minimal severity-counts shape needsExplicitApproval reads. Any missing key
 * reads as 0, so a caller can pass a verdict's `severity_counts` straight through.
 */
export type ApprovalCounts = Partial<Record<SecSeverity, number>>;

/** Read a severity count, treating a missing/NaN/<=0 value as 0 (fail toward warning). */
function severityCount(counts: ApprovalCounts | undefined, sev: SecSeverity): number {
  const n = counts?.[sev];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Does this verdict require an EXPLICIT user approval (the §5.2 checkbox-gated
 * "Install anyway"), versus a soft hold? Mirrors core `needsExplicitApproval`:
 *   - block / error ⇒ always true (must run the Force flow);
 *   - allow ⇒ always false;
 *   - warn ⇒ true iff any CRITICAL/HIGH finding (or MEDIUM under strict policy).
 * Reads ONLY engine-provided counts — NO scoring (C5).
 */
export function needsExplicitApproval(
  tier: SecVerdictTier,
  counts: ApprovalCounts | undefined,
  opts: { strict?: boolean } = {},
): boolean {
  if (tier === "block" || tier === "error") return true;
  if (tier === "allow") return false;
  const serious = severityCount(counts, "CRITICAL") + severityCount(counts, "HIGH");
  if (serious > 0) return true;
  if (opts.strict && severityCount(counts, "MEDIUM") > 0) return true;
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * TYPED-CONFIRM GATES (file 03 §5.3 / §9.3) — a LOCAL mirror of @prometheus/core
 * `forceToken`. Same EXACT-MATCH-ONLY guards: the engine still re-checks on its
 * side, the GUI only enables a button (it never weakens the gate — C5).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The engine's EXACT deep-red override token (prometheus.py `_confirm_dangerous_override`). */
export const FORCE_TOKEN = "install-dangerous" as const;

/**
 * Does the typed input EXACTLY equal the force token? Exact compare only — no
 * trim, no case-fold, no near-miss. A non-string is false (CTA stays disabled).
 */
export function matchesForceToken(input: unknown): boolean {
  return input === FORCE_TOKEN;
}

/**
 * The basename of a logical path (the tail after the last "/" or "\\"). In-archive
 * members ("pkg.zip!member") keep the member tail. Pure string work.
 */
export function purgeBasename(path: string): string {
  if (typeof path !== "string" || path.length === 0) return "";
  const trimmed = path.replace(/[/\\]+$/, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

/**
 * Does the typed name EXACTLY match the artifact's filename (basename), gating the
 * §9.3 Purge CTA? A non-string `typed`, an empty typed/filename, or any mismatch
 * returns false — the irreversible CTA stays disabled (fail toward safety).
 */
export function purgeNameMatches(typed: unknown, filename: string): boolean {
  if (typeof typed !== "string") return false;
  const expected = purgeBasename(filename);
  if (expected.length === 0) return false;
  return typed === expected;
}

/* ────────────────────────────────────────────────────────────────────────────
 * DISINFECT PLAN (file 03 §9.1) — a PURE split of a verdict's findings into the
 * wizard's two buckets. NO judgement: `finding.remediable` is the engine-DERIVED
 * flag (in-archive ⇒ never remediable); we only partition by it.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Split findings into Remediable (will be neutralised in place, a `.bak` kept)
 * vs. quarantine-only (hard malware / in-archive — can only be sidelined). Pure
 * partition on the engine's `remediable` flag; order is preserved.
 */
export function disinfectPlan(findings: readonly SecFinding[]): SecDisinfectPlan {
  const remediable: SecFinding[] = [];
  const quarantineOnly: SecFinding[] = [];
  for (const f of findings ?? []) {
    if (f.remediable) remediable.push(f);
    else quarantineOnly.push(f);
  }
  return { remediable, quarantineOnly };
}

/* ────────────────────────────────────────────────────────────────────────────
 * AUDIT-LOG FILTER (file 03 §8) — a PURE predicate so the AuditLogView's filters
 * (forced-danger only / blocks only / last 24h) are testable without a DOM. NO
 * judgement: it reads only the engine-written row fields.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Was this audit row a forced dangerous override? (decision === forced token / tier block+proceeded). */
function isForcedRow(row: SecAuditLogEntry): boolean {
  const decision = (row.decision ?? "").toLowerCase();
  return decision.includes("force") || decision.includes("dangerous");
}

/** Did this row's tier halt by default (block/error)? */
function isBlockRow(row: SecAuditLogEntry): boolean {
  const t = (row.tier || row.verdict || "").toLowerCase();
  return t === "block" || t === "error";
}

/**
 * Does an audit row pass the active display filter (§8)? Pure. An empty/all-false
 * filter passes everything. `now` is injectable so the last-24h test is
 * deterministic (defaults to Date.now()). A row with an unparseable timestamp is
 * EXCLUDED by the last24h filter (fail toward hiding stale/garbage rows).
 */
export function auditRowMatches(
  row: SecAuditLogEntry,
  filter: SecAuditFilter,
  now: number = Date.now(),
): boolean {
  if (filter.forcedOnly && !isForcedRow(row)) return false;
  if (filter.blocksOnly && !isBlockRow(row)) return false;
  if (filter.last24h) {
    const t = Date.parse(row.at);
    if (Number.isNaN(t)) return false;
    if (now - t > 24 * 60 * 60 * 1000) return false;
  }
  return true;
}

/** Apply an audit filter to a list of rows (pure; preserves order). */
export function filterAuditRows(
  rows: readonly SecAuditLogEntry[],
  filter: SecAuditFilter,
  now: number = Date.now(),
): SecAuditLogEntry[] {
  return (rows ?? []).filter((r) => auditRowMatches(r, filter, now));
}
