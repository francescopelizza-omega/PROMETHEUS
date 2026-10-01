// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * security/index.ts — the Security-Center component barrel (file 03 §4–§9).
 *
 * The ten presentational components the renderer wires `window.prometheus.
 * security.*` to, plus the pure display/guard helpers and the renderer-facing
 * display shapes. EVERYTHING here is C5-sandboxed: it imports only `react` + its
 * own modules + the @prometheus/ui tokens — never node:*, electron, or the
 * engine-bridge runtime. Color/label/decision NEVER originate here: they come
 * from the §3 verdictMapping mirror and the engine-computed verdict (C5).
 */

/* ── components (§4–§9) ─────────────────────────────────────────────────────── */
export { VerdictSheet } from "./VerdictSheet.js";
export type { VerdictSheetProps } from "./VerdictSheet.js";
export { ForceOverrideDialog } from "./ForceOverrideDialog.js";
export type { ForceOverrideDialogProps } from "./ForceOverrideDialog.js";
export { DangerRibbon } from "./DangerRibbon.js";
export type { DangerRibbonProps } from "./DangerRibbon.js";
export { ThreatDbPanel } from "./ThreatDbPanel.js";
export type { ThreatDbPanelProps } from "./ThreatDbPanel.js";
export { QuarantineVault } from "./QuarantineVault.js";
export type { QuarantineVaultProps } from "./QuarantineVault.js";
export { DisinfectWizard } from "./DisinfectWizard.js";
export type { DisinfectWizardProps } from "./DisinfectWizard.js";
export { PurgeDialog } from "./PurgeDialog.js";
export type { PurgeDialogProps } from "./PurgeDialog.js";
export { AuditLogView } from "./AuditLogView.js";
export type { AuditLogViewProps } from "./AuditLogView.js";
export { TrustedSourcesView } from "./TrustedSourcesView.js";
export type { TrustedSourcesViewProps } from "./TrustedSourcesView.js";
export { FindingRow } from "./FindingRow.js";
export type { FindingRowProps } from "./FindingRow.js";

/* ── pure display + guard helpers (§2.1 / §3 / §5.3 / §8 / §9) ───────────────── */
export {
  stripAnsi,
  inertText,
  VERDICT_DISPLAY,
  verdictDisplay,
  roleVar,
  needsExplicitApproval,
  FORCE_TOKEN,
  matchesForceToken,
  purgeBasename,
  purgeNameMatches,
  disinfectPlan,
  auditRowMatches,
  filterAuditRows,
} from "./util.js";
export type { ApprovalCounts } from "./util.js";

/* ── renderer-facing display shapes (structural mirrors of the engine types) ── */
export type {
  SecVerdictTier,
  SecSeverity,
  SecFinding,
  SecDbProvenance,
  SecIndicatorsLoaded,
  SecProvenance,
  SecSafeTo,
  SecSignature,
  SecVerdict,
  SecVerdictDisplay,
  SecForcedDanger,
  SecTrustedSource,
  SecAuditLogEntry,
  SecThreatDbStatus,
  SecFeedStatus,
  SecQuarantineItem,
  SecDisinfectPlan,
  SecVerifyResult,
  SecAuditFilter,
} from "./types.js";
