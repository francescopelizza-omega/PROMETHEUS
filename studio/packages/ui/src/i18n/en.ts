/**
 * i18n/en.ts — the default (English) message catalog (08 §7 "Localization-ready:
 * all copy via an i18n catalog; no concatenated sentences").
 *
 * Keys are dotted by component. Values are ICU-lite templates with {param}
 * placeholders so the CATALOG owns word order (a translator can re-order around
 * the params) — never JS string concatenation. A new locale ships the same keys.
 */

export const en = {
  // VerdictBadge spoken label (08 §7 screen readers).
  "verdictBadge.spoken": "{label}",
  "verdictBadge.spokenRisk": "{label}, risk {risk} of 100",

  // FindingRow accessible row name (severity, rule, location).
  "findingRow.spoken": "{severity}, {rule}, {loc}",
  "findingRow.openLocation": "Open {loc}",
  "findingRow.expand": "Expand finding detail",
  "findingRow.collapse": "Collapse finding detail",

  // VerdictSheet / VerdictPanel (the §5.2 gate modal).
  "verdict.sheetLabel": "Security verdict: {label}",
  "verdict.blockingReasons": "Blocking reasons",
  "verdict.findings": "Findings",
  "verdict.findingsCount": "Findings ({count})",
  "verdict.install": "Install",
  "verdict.installAnyway": "Install anyway",
  "verdict.disinfectInstall": "Disinfect & install",
  "verdict.quarantine": "Quarantine source",
  "verdict.viewJson": "View full signed verdict (JSON)",
  "verdict.cancel": "Cancel",
  "verdict.force": "Force…",
  "verdict.honestyStatic": "Heuristic static analysis — not a sandbox.",
  "verdict.errorCopy": "scanner unavailable or timed out — treated as unsafe (fail-closed).",
  // Per-tier honesty caption for the §5.2 gate panel (no concatenated sentences, 08 §7).
  "verdict.honestyAllow": "Heuristic static analysis — not a sandbox.",
  "verdict.honestyWarn":
    "Review the findings before proceeding. Heuristic static analysis — not a sandbox.",
  "verdict.honestyError": "Scanner unavailable or timed out — treated as unsafe (fail-closed).",
  "verdict.honestyBlock":
    "This artifact will NOT be installed. Heuristic static analysis — not a sandbox.",

  // StatusBar nemesis shield.
  "statusBar.shield": "nemesis security: {tier}",
} as const;

/** The set of catalog keys (every locale must provide these). */
export type MessageKey = keyof typeof en;

export default en;
