/**
 * patterns/ — the product components that ARE Prometheus (08 §3.2).
 *
 * Each binds a real engine data shape (via the TYPE-ONLY mirrors in ./types.ts —
 * C5: @prometheus/ui imports only react + its own modules) and renders the verdict/
 * fit/state the ENGINE already computed. They NEVER score, fit, allowlist, or decide
 * "safe" — every action is a callback PROP and every engine string is run inert.
 *
 * The verdict atom (<VerdictBadge>) is re-exported here from its canonical home in
 * components/ so the §3.2 pattern surface is complete in one import, WITHOUT moving
 * the existing component (its package-root export + the renderer consumer stay put).
 */

/* ── display shapes (the §3.2 prop mirrors) ──────────────────────────────────── */
export type {
  PatternFinding,
  PatternVerdictReport,
  ModelQuant,
  ModelCardData,
  VenvRowData,
  PackageRowData,
  CatalogItemData,
  AgentPresence,
  AgentCounts,
  StreamLogLine,
  EngineStateData,
} from "./types.js";

/* ── pure display helpers (the testable core) ────────────────────────────────── */
export {
  inert,
  roleVar,
  verdictRole,
  verdictGlyph,
  verdictLabel,
  verdictVar,
  severityKey,
  severityRole,
  severityGlyph,
  severityVar,
  severityRank,
  sortFindings,
  klassRole,
  klassVar,
  stateRole,
  stateGlyph,
  stateVar,
  riskBand,
  riskVar,
  clampRisk,
  riskFraction,
  RISK_WARN_THRESHOLD,
  RISK_BLOCK_THRESHOLD,
  tierGlyph,
  tierLabel,
  isDocumentedOnly,
  presenceGlyph,
  presenceRole,
  presenceVar,
  countsLabel,
  countsTotal,
  streamLevelRole,
  streamLevelVar,
  shieldTier,
  engineSummary,
  formatBytes,
  formatCount,
  clampFitRatio,
  fitMeterRole,
  fitMeterVar,
  meterBar,
} from "./util.js";
export type { StatePill, RiskBand, StreamLevel, EngineProbe } from "./util.js";

/* ── the product pattern components (08 §3.2) ────────────────────────────────── */
export { VerdictBadge } from "../components/VerdictBadge.js";
export type { VerdictBadgeProps } from "../components/VerdictBadge.js";
export { FindingRow } from "./FindingRow.js";
export type { FindingRowProps } from "./FindingRow.js";
export { StatusMark } from "./StatusMark.js";
export type { StatusMarkProps, Presence } from "./StatusMark.js";
export { VerdictPanel } from "./VerdictPanel.js";
export type { VerdictPanelProps } from "./VerdictPanel.js";
export { ModelCard } from "./ModelCard.js";
export type { ModelCardProps } from "./ModelCard.js";
export { VenvRow, PackageRow } from "./VenvRow.js";
export type { VenvRowProps, PackageRowProps } from "./VenvRow.js";
export { CatalogItem } from "./CatalogItem.js";
export type { CatalogItemProps } from "./CatalogItem.js";
export { AgentStatusDot } from "./AgentStatusDot.js";
export type { AgentStatusDotProps } from "./AgentStatusDot.js";
export { StreamLog } from "./StreamLog.js";
export type { StreamLogProps } from "./StreamLog.js";
export { RiskGauge } from "./RiskGauge.js";
export type { RiskGaugeProps } from "./RiskGauge.js";
export { EngineState } from "./EngineState.js";
export type { EngineStateProps } from "./EngineState.js";
export { VerdictCard } from "./VerdictCard.js";
export type { VerdictCardProps, VerdictCardFinding } from "./VerdictCard.js";
export { PermissionCard } from "./PermissionCard.js";
export type { PermissionCardProps, PermissionKind } from "./PermissionCard.js";
export { LatencyCard, formatMs } from "./LatencyCard.js";
export type { LatencyCardProps, LatencyPhases } from "./LatencyCard.js";
