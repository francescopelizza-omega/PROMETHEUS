/**
 * env/types.ts — the renderer-facing DISPLAY shapes the §3/§5 env components
 * render, as @prometheus/ui-LOCAL structural mirrors (same discipline as
 * security/types.ts).
 *
 * WHY MIRRORED HERE (not imported): @prometheus/ui is a sandboxed presentational
 * package (C5). It may import ONLY `react` + its own modules — it may NOT import
 * `@prometheus/engine-bridge` or `@prometheus/core` runtime, and has no project
 * reference to them, so a cross-package type import would not resolve under
 * `tsc -b`. These interfaces are STRUCTURAL mirrors of engine-bridge's `Env` /
 * `Package` / `GpuInfo` and core's `Template`/`GatePlanItem`/`PkgState`. Because
 * they are structural, the renderer (which DOES depend on both) passes a real
 * engine-bridge `Env`/`Package`/`GpuInfo` straight into these props with no
 * adapter — structural typing makes them assignment-compatible.
 *
 * GOLDEN RULE (C5): these are DISPLAY shapes only. The components that consume
 * them NEVER score, allowlist, or decide "safe" — they render data the engine /
 * sidecar produced and accept every action as a callback prop.
 */

import type { GateTier, RowState } from "./util.js";

/** A gate verdict summary the row/sheet renders — mirror of engine-bridge GateSummary. */
export interface EnvGateBadge {
  verdict: GateTier;
  score?: number;
  reasons?: string[];
  signed?: boolean;
  recommendation?: string;
  scannedAt?: string;
}

/** An environment row — structural mirror of engine-bridge `Env` (the fields the UI uses). */
export interface EnvRowData {
  id: string;
  name: string;
  kind: string; // 'venv' | 'virtualenv' | 'conda' | 'pyenv' | 'system' | 'engine'
  scope: string; // 'global' | 'project' | 'engine'
  path: string;
  pythonPath: string;
  pythonVersion: string;
  active: boolean;
  managedBy: string; // 'studio' | 'engine' | 'external'
  /** absent when the sidecar could not count them — NOT the same as zero. */
  packageCount?: number;
  sizeBytes?: number;
  health: string; // 'ok' | 'degraded' | 'broken' | 'unknown'
  cuda?: { available: boolean; torchCuda?: string };
  createdAt?: string;
  origin?: string;
  templateId?: string;
}

/** A package row — structural mirror of engine-bridge `Package` + its live state. */
export interface PackageRowData {
  name: string;
  installed?: string;
  latest?: string;
  source: string;
  envId: string;
  state: RowState;
  pinned?: string;
  requestedBy?: string;
  gate?: EnvGateBadge;
}

/** GPU/CUDA info — structural mirror of engine-bridge `GpuInfo` (§5.2). */
export interface GpuInfoData {
  hasNvidia: boolean;
  driverVersion?: string;
  cudaRuntime?: string;
  nvccVersion?: string;
  gpus: { name: string; vramTotalMB: number; vramFreeMB: number; computeCap?: string }[];
  recommendedTorchIndex?: string;
  toolkitInstalled: boolean;
  torchCuda?: boolean;
}

/** One init-package template row — structural mirror of engine-bridge `Template`. */
export interface TemplateData {
  id: string;
  title: string;
  description: string;
  pythonHint?: string;
  packages: {
    name: string;
    version?: string;
    source?: string;
    extras?: string[];
    optional?: boolean;
    note?: string;
  }[];
  needs?: string[];
  postNotes?: string[];
  builtin: boolean;
}

/** One resolved gate-plan item the wizard step ③ previews (mirror of core GatePlanItem). */
export interface GatePlanItemData {
  name: string;
  spec: string;
  source: string;
  indexUrl?: string;
  optional?: boolean;
  /** present once the engine has scanned this item (else "pending"). */
  gate?: EnvGateBadge;
}
