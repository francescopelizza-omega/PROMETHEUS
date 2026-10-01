// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * env.types.ts — the canonical TS shapes for the Package & Environment Manager
 * (file 04 §2). These are a deliberate SUPERSET of what `envmgr.py` emits today,
 * so the GUI can render conda + bare-venv + engine-managed `venv_<tool>/` trees
 * uniformly. The sidecar emits snake_case JSON; `env.ts` camelCases it at the
 * boundary — these are the camelCase, post-boundary shapes the rest of the app
 * (core/ui/desktop) consumes.
 *
 * GateBadge is SHARED with file 03 (security). We do NOT redefine it here — it is
 * re-exported from ./security/verdict.js so there is exactly one source of truth.
 */

// The GateBadge shape lives in the security module (file 03 §3). Re-export, never
// redefine — the gate verdict is the engine's; we only carry its summary.
export type { GateBadge } from "./security/verdict.js";

// ── Env ──────────────────────────────────────────────────────────────────────

/**
 * What kind of Python environment this is.
 *   'engine' = a `venv_<tool>/` workspace that prometheus.py owns (AirLLM, the
 *   FlashAttention target, …) — surfaced read-mostly; its mutations route to the
 *   Model Hub (file 05) so we never desync the engine's versioned-rollback books.
 */
export type EnvKind = "venv" | "virtualenv" | "conda" | "pyenv" | "system" | "engine";

/** project = bound to a workspace folder open in the editor (file 07). */
export type EnvScope = "global" | "project" | "engine";

/** Who created the env — governs which destructive ops we allow. */
export type EnvManagedBy = "studio" | "engine" | "external";

/** pyvenv.cfg parses? interpreter runs? pip resolves? */
export type EnvHealth = "ok" | "degraded" | "broken" | "unknown";

/** How this env came to exist (provenance for the picker + housekeeping). */
export type EnvOrigin = "template" | "manual" | "cloned" | "imported";

/** Per-env CUDA visibility — does THIS env's torch see CUDA? (not host-wide). */
export interface EnvCuda {
  available: boolean;
  torchCuda?: string;
}

export interface Env {
  /** stable hash of the absolute path, e.g. "env_9af3…". */
  id: string;
  /** display name (folder name / conda env name / user-chosen). */
  name: string;
  kind: EnvKind;
  scope: EnvScope;
  /** ABSOLUTE env root (the dir holding bin/Scripts + pyvenv.cfg / conda-meta). */
  path: string;
  /** ABSOLUTE interpreter path → what the editor (file 07) binds as the interpreter. */
  pythonPath: string;
  /** "3.11.9" (empty string when the interpreter could not be probed). */
  pythonVersion: string;
  /** is this the currently-selected env in Studio? (derived at the boundary). */
  active: boolean;
  managedBy: EnvManagedBy;
  /** the interpreter a venv was cloned from (pyvenv.cfg `home=`) — clone provenance. */
  basePrefix?: string;
  /** cheap count for the picker; the full list is fetched lazily via pkgList(). */
  /** absent when the sidecar could not count them — NOT the same as zero. */
  packageCount?: number;
  /** disk footprint (for the delete confirm + housekeeping). */
  sizeBytes?: number;
  /** does THIS env's torch see CUDA? (per-env, not host-wide). */
  cuda?: EnvCuda;
  createdAt?: string;
  lastUsedAt?: string;
  origin?: EnvOrigin;
  /** present iff origin === 'template'. */
  templateId?: string;
  health: EnvHealth;
}

// ── Package ──────────────────────────────────────────────────────────────────

export type PkgState =
  | "installed"
  | "enabled"
  | "disabled"
  | "outdated"
  | "absent"
  | "pending"
  | "blocked";

export type PkgSource =
  | "pypi"
  | "conda"
  | "conda-forge"
  | "git"
  | "local-wheel"
  | "editable"
  | "cuda";

export interface Package {
  /** normalized (PEP 503): "Pillow" → "pillow". */
  name: string;
  /** installed version, undefined if absent. */
  installed?: string;
  /** newest on the index (lazy; fills the "update available" column). */
  latest?: string;
  source: PkgSource;
  /** which Env it lives in ('' for global/system pip). */
  envId: string;
  state: PkgState;
  /** a constraint the user/template pinned ("==2.1.*", ">=4.40"). */
  pinned?: string;
  /** ["cu121"], ["torch"], … */
  extras?: string[];
  /** dim transitive deps in the table. */
  requestedBy?: "user" | "template" | "dependency";
  size?: number;
  /** last nemesis verdict for the *fetch* of this package (file 04 §6). */
  gate?: import("./security/verdict.js").GateBadge;
  /** path of the .studio-disabled sentinel when state === 'disabled'. */
  disabledMarker?: string;
}

// ── Template ─────────────────────────────────────────────────────────────────

export interface TemplatePkg {
  name: string;
  version?: string;
  source?: PkgSource;
  extras?: string[];
  /** optional → unchecked-by-default row in the wizard. */
  optional?: boolean;
  note?: string;
}

export interface Template {
  /** "ml-starter" | "llm-serving" | "data-science" | "notebook-min" | … */
  id: string;
  /** "ML Starter (PyTorch + sklearn)". */
  title: string;
  description: string;
  /** ">=3.10,<3.13" — warn if the chosen interpreter is out of range. */
  pythonHint?: string;
  /** ordered; the user edits this list in the wizard before commit. */
  packages: TemplatePkg[];
  /** surfaced as prerequisite chips. */
  needs?: ("nvidia" | "docker" | "rust" | "cmake")[];
  /** shown after create (mirrors ModelTool.post_notes phrasing). */
  postNotes?: string[];
  /** ALL templates are user-customizable before commit. */
  editable: true;
  /** shipped vs. user-saved. */
  builtin: boolean;
}

// ── CUDA / GPU ───────────────────────────────────────────────────────────────

export interface GpuDevice {
  name: string;
  vramTotalMB: number;
  vramFreeMB: number;
  computeCap?: string;
}

export interface GpuInfo {
  /** == prometheus.py `_has_nvidia()` (nvidia-smi || nvcc on PATH). */
  hasNvidia: boolean;
  /** from nvidia-smi. */
  driverVersion?: string;
  /** highest CUDA the driver supports (nvidia-smi header). */
  cudaRuntime?: string;
  /** toolkit on PATH (nvcc --version) — may differ from the runtime. */
  nvccVersion?: string;
  gpus: GpuDevice[];
  /** "https://download.pytorch.org/whl/cu121" derived from cudaRuntime. */
  recommendedTorchIndex?: string;
  /** a CUDA *toolkit* (nvcc) present vs. just the driver. */
  toolkitInstalled: boolean;
  /** does some torch see CUDA on this host? (best-effort; may be null/undefined). */
  torchCuda?: boolean;
}
