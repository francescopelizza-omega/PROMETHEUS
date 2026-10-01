// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * env/index.ts — the Environments component barrel (file 04 §3/§5).
 *
 * The presentational components the renderer wires `window.prometheus.env.*` to,
 * plus the pure display helpers and the renderer-facing display shapes. EVERYTHING
 * here is C5-sandboxed: it imports only `react` + its own modules + the
 * @prometheus/ui security barrel (for the re-used VerdictSheet) — never node:*,
 * electron, or the engine-bridge / core runtime. The gate decision NEVER
 * originates here: it comes from the engine, carried in as data props.
 */

/* ── components (§3/§5) ──────────────────────────────────────────────────────── */
export { EnvPicker } from "./EnvPicker.js";
export type { EnvPickerProps } from "./EnvPicker.js";
export { PackageTable } from "./PackageTable.js";
export type { PackageTableProps, PackageRowCallbacks } from "./PackageTable.js";
export { GateBadge } from "./GateBadge.js";
export type { GateBadgeProps } from "./GateBadge.js";
export { CreateEnvWizard } from "./CreateEnvWizard.js";
export type {
  CreateEnvWizardProps,
  CreateEnvPayload,
  DetectedInterpreter,
} from "./CreateEnvWizard.js";
export { CudaPanel } from "./CudaPanel.js";
export type { CudaPanelProps } from "./CudaPanel.js";
export { GateVerdictSheet } from "./GateVerdictSheet.js";
export type { GateVerdictSheetProps } from "./GateVerdictSheet.js";

/* ── pure display helpers (§3/§5/§9) ─────────────────────────────────────────── */
// NOTE: `roleVar` is NOT re-exported here — the security barrel already exports a
// `roleVar` at the top-level @prometheus/ui surface; re-exporting the env one would
// collide (TS2308). It stays an env-internal helper (the components use it directly).
export {
  inert,
  gateRole,
  gateGlyph,
  gateLabel,
  gateRefuses,
  rowStateRole,
  rowStateGlyph,
  healthRole,
  healthGlyph,
  formatBytes,
  allowsDestructive,
  managedByLabel,
  createStepValid,
  plannedCount,
  rowActions,
  gateToVerdict,
} from "./util.js";
export type { GateTier, RowState, EnvRole, WizardPkgRow } from "./util.js";

/* ── renderer-facing display shapes (structural mirrors of the engine types) ─── */
export type {
  EnvGateBadge,
  EnvRowData,
  PackageRowData,
  GpuInfoData,
  TemplateData,
  GatePlanItemData,
} from "./types.js";
