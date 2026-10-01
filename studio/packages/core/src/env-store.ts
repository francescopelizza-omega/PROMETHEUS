// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * env-store.ts — the framework-free env + package lifecycle layer (file 04 §7,§9).
 *
 * This is the ISOMORPHIC core of the Environments tab: a PURE reducer state
 * machine for each package row, the selectors the GUI/CLI both read, the
 * CUDA-aware template→spec resolver (§7), and the batched-gate-plan shape (§6).
 *
 * Deliberately NO react / NO zustand import — core must stay isomorphic and be
 * consumed by BOTH the desktop renderer (which wraps this in a Zustand store)
 * and the `prometheus` CLI. The Zustand binding lives in apps/desktop/src; this file
 * owns only the transition math + selectors so both surfaces behave identically.
 *
 * GOLDEN RULE (C5): nothing here decides "safe". The state machine MODELS the
 * verdict outcome the engine/nemesis produced — a `gateBlock` event is the only
 * way a row reaches the terminal `blocked` state, and `blocked` is escaped only
 * by a re-scan (gate clears) or a force override the security layer authorised.
 */

import type { CudaInfo, Env, Package } from "./domain/models.js";

// ====================================================================== //
//  §2 data shapes — the RICHER Template/TemplatePkg the wizard edits.     //
//  (Distinct from domain/models.ts `Template`, which is the sidecar's     //
//   `template.list` envelope. This is the file-04 §2 shape the GUI uses.)  //
// ====================================================================== //

/** Lifecycle state of one package row (file 04 §2 / §9). */
export type PkgState =
  | "absent"
  | "pending"
  | "installed"
  | "enabled"
  | "disabled"
  | "outdated"
  | "blocked";

/** Where a package is fetched from (file 04 §2). */
export type PkgSource =
  | "pypi"
  | "conda"
  | "conda-forge"
  | "git"
  | "local-wheel"
  | "editable"
  | "cuda";

/** A single template package row the user edits before commit (file 04 §2). */
export interface TemplatePkg {
  name: string;
  version?: string;
  source?: PkgSource;
  extras?: string[];
  /** optional → unchecked-by-default row in the wizard. */
  optional?: boolean;
  note?: string;
  requestedBy?: "user" | "template" | "dependency";
}

/** An init-package template (file 04 §2 / §7). ALL templates are editable. */
export interface Template {
  id: string;
  title: string;
  description: string;
  /** ">=3.10,<3.13" — warn if the chosen interpreter is out of range. */
  pythonHint?: string;
  packages: TemplatePkg[];
  /** surfaced as prerequisite chips. */
  needs?: ("nvidia" | "docker" | "rust" | "cmake")[];
  /** shown after create (mirrors ModelTool.post_notes phrasing). */
  postNotes?: string[];
  /** ALL templates are user-customizable before commit. */
  editable: true;
  /** shipped (true) vs. user-saved (false). */
  builtin: boolean;
}

// ====================================================================== //
//  §9 state machine — the per-row lifecycle as a PURE reducer.            //
// ====================================================================== //

/**
 * The transition events (file 04 §9 edges + the §5 verb set):
 *   install   absent → pending          (queue a fetch; gate decides next)
 *   template  absent → pending          (same as install, template-sourced)
 *   gateClean pending → installed       (nemesis allow/warn-ok)
 *   gateBlock pending → blocked         (nemesis block/error — TERMINAL until rescan/force)
 *   update    installed → pending       (re-fetch latest; re-gates)
 *   upgrade   outdated  → pending       (bulk update of an outdated row)
 *   markOutdated installed → outdated   (passive: latest>installed; badge only)
 *   disable   installed → disabled      (reversible sentinel; pin kept)
 *   enable    disabled  → pending       (re-gate from cache, then installed)
 *   remove    installed/disabled/outdated/blocked → absent  (drop pkg, keep pin)
 *   uninstall <any>     → absent         (remove AND forget the pin/cache)
 *   rescan    blocked   → pending        (re-run the gate from scratch)
 *   forceInstall blocked → installed     (security-authorised --force override)
 */
export type PkgEvent =
  | "install"
  | "template"
  | "gateClean"
  | "gateBlock"
  | "update"
  | "upgrade"
  | "markOutdated"
  | "disable"
  | "enable"
  | "remove"
  | "uninstall"
  | "rescan"
  | "forceInstall";

/** A transition outcome: the next state, or null if the event is illegal here. */
type Next = PkgState | null;

/**
 * The transition table (file 04 §9). Each entry maps a current state to the
 * events legal in it. An event NOT listed for a state is a no-op (returns the
 * same state) — the reducer never throws, so an out-of-order GUI event can't
 * crash the table. `blocked` is TERMINAL: only `rescan`, `forceInstall`,
 * `remove`, `uninstall` leave it (never a passive transition toward installed).
 */
const TRANSITIONS: Readonly<Record<PkgState, Partial<Record<PkgEvent, PkgState>>>> = Object.freeze({
  absent: {
    install: "pending",
    template: "pending",
  },
  pending: {
    gateClean: "installed",
    gateBlock: "blocked",
    // a queued fetch can be cancelled back to absent
    remove: "absent",
    uninstall: "absent",
  },
  installed: {
    update: "pending",
    upgrade: "pending",
    markOutdated: "outdated",
    disable: "disabled",
    remove: "absent",
    uninstall: "absent",
  },
  // `enabled` is an alias the engine emits for an active install; treat it like
  // `installed` so a row reported as enabled accepts the same transitions.
  enabled: {
    update: "pending",
    upgrade: "pending",
    markOutdated: "outdated",
    disable: "disabled",
    remove: "absent",
    uninstall: "absent",
  },
  outdated: {
    update: "pending",
    upgrade: "pending",
    disable: "disabled",
    remove: "absent",
    uninstall: "absent",
  },
  disabled: {
    // re-enable re-gates from cache (file 04 §5) → goes through pending again
    enable: "pending",
    remove: "absent",
    uninstall: "absent",
  },
  blocked: {
    // TERMINAL: escape only via an explicit rescan, a forced override, or drop.
    rescan: "pending",
    forceInstall: "installed",
    remove: "absent",
    uninstall: "absent",
  },
});

/**
 * The pure transition function (file 04 §9). Given a current state and an event,
 * returns the next state. An illegal/irrelevant event is a NO-OP (returns the
 * input state unchanged) so the table is total and never throws.
 *
 * This is the single source of lifecycle truth: the Zustand binding in the
 * renderer and the `prometheus pkg` CLI both call THIS, so a row can never reach a
 * state the security model forbids (e.g. blocked → installed without force).
 */
export function pkgTransition(state: PkgState, event: PkgEvent): PkgState {
  const next: Next = TRANSITIONS[state]?.[event] ?? null;
  return next ?? state;
}

/** Is an event legal (i.e. actually moves/changes the row) in this state? */
export function canTransition(state: PkgState, event: PkgEvent): boolean {
  const next = TRANSITIONS[state]?.[event];
  return next !== undefined && next !== state;
}

/** The events legal in a given state (for enabling/disabling row action buttons). */
export function legalEvents(state: PkgState): PkgEvent[] {
  return Object.keys(TRANSITIONS[state] ?? {}) as PkgEvent[];
}

/**
 * Is this the TERMINAL gate-block state (file 04 §9)? `blocked` halts the row
 * until an explicit rescan or a security-authorised force — it never decays back
 * toward installed on its own. Exposed so the GUI can paint the deep-red row +
 * the CLI can exit non-zero on a blocked install.
 */
export function isBlockedTerminal(state: PkgState): boolean {
  return state === "blocked";
}

// ====================================================================== //
//  Store STATE + selectors (framework-free; the renderer wraps in zustand)//
// ====================================================================== //

/** A package row as the table renders it: the domain Package + its live state. */
export interface PackageRow {
  pkg: Package;
  state: PkgState;
}

/** The isomorphic env-store state (NO framework; a plain serialisable shape). */
export interface EnvStoreState {
  envs: Env[];
  /** id (path) of the currently-selected env, or null. */
  selectedEnvPath: string | null;
  /** package rows keyed by env path → name → row. */
  packages: Record<string, PackageRow[]>;
}

/** The empty initial state. */
export function initialEnvStoreState(): EnvStoreState {
  return { envs: [], selectedEnvPath: null, packages: {} };
}

/** Selector: the currently-selected Env (or null if none / not found). */
export function selectSelectedEnv(s: EnvStoreState): Env | null {
  if (s.selectedEnvPath === null) return null;
  return s.envs.find((e) => e.path === s.selectedEnvPath) ?? null;
}

/** Selector: the package rows of the selected env (empty array if none). */
export function selectPackageRows(s: EnvStoreState): PackageRow[] {
  if (s.selectedEnvPath === null) return [];
  return s.packages[s.selectedEnvPath] ?? [];
}

/** Selector: rows in a given lifecycle state (e.g. all `outdated` for "Update all"). */
export function selectRowsByState(s: EnvStoreState, state: PkgState): PackageRow[] {
  return selectPackageRows(s).filter((r) => r.state === state);
}

// ====================================================================== //
//  §7 template resolution — Template → pip/conda specs (CUDA-aware).      //
// ====================================================================== //

/** A resolved install spec for one package (what the gate plan stages). */
export interface ResolvedSpec {
  /** the package this came from (normalized, lowercase). */
  name: string;
  /** the literal install argument: "torch", "transformers>=4.40", "vllm". */
  spec: string;
  source: PkgSource;
  /** an explicit index URL for CUDA-matched wheels (torch → .../cuXXX). */
  indexUrl?: string;
  /** carried through from the template so the wizard can dim transitive deps. */
  optional?: boolean;
}

/** Default PyPI source when a TemplatePkg omits one. */
const DEFAULT_SOURCE: PkgSource = "pypi";

/** Packages whose CPU/GPU wheel differs by CUDA index (file 04 §7). */
const CUDA_WHEEL_PACKAGES = new Set(["torch", "torchvision", "torchaudio"]);

/**
 * Derive the torch CUDA wheel index from a CudaInfo (file 04 §7 / §5.2).
 * "12.4"/"12.1" → cu121 (the published wheel line), "11.8" → cu118. When CUDA
 * is unavailable returns undefined (CPU/MPS build — NO index pin).
 *
 * This is a DISPLAY/spec mapping only — it never decides whether a GPU exists;
 * it reads the engine's `cuda.info` probe (`available` + `cudaVersion`).
 */
export function torchCudaIndex(gpu: CudaInfo | null | undefined): string | undefined {
  if (!gpu || !gpu.available) return undefined;
  const ver = gpu.cudaVersion ?? "";
  const major = Number.parseInt(ver.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major)) {
    // CUDA present but version unparseable → conservative default wheel line.
    return "https://download.pytorch.org/whl/cu121";
  }
  if (major >= 12) return "https://download.pytorch.org/whl/cu121";
  if (major === 11) return "https://download.pytorch.org/whl/cu118";
  // very old / unexpected runtime → still pin a defined line rather than CPU.
  return "https://download.pytorch.org/whl/cu118";
}

/** Normalize a package name to PEP 503 (lowercase, runs of -_. → single -). */
function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
}

/** Build the literal pip spec string from a TemplatePkg (name + version + extras). */
function pkgSpecString(p: TemplatePkg): string {
  const extras = p.extras && p.extras.length > 0 ? `[${p.extras.join(",")}]` : "";
  const version = p.version ? p.version.trim() : "";
  // a version that already carries an operator (>=, ==, ~=, <) is appended raw;
  // a bare "2.3.1" is pinned with ==.
  const versionPart = version ? (/^[<>=!~]/.test(version) ? version : `==${version}`) : "";
  return `${p.name}${extras}${versionPart}`;
}

/**
 * Resolve a Template into install specs (file 04 §7). CUDA-aware: a torch row
 * resolves to the CUDA-matched wheel index when a GPU is present, else the bare
 * CPU/MPS spec. By default only DEFAULT-CHECKED (non-optional) packages are
 * resolved — pass `includeOptional` to fold in the opt-in rows the user ticked.
 *
 * PURE: depends only on its inputs. It NEVER fetches, NEVER gates — it only
 * produces the spec list the batched gate plan (§6) will stage and scan.
 */
export function templateResolve(
  template: Template,
  gpu?: CudaInfo | null,
  opts: { includeOptional?: boolean } = {},
): ResolvedSpec[] {
  const out: ResolvedSpec[] = [];
  for (const p of template.packages) {
    if (p.optional && !opts.includeOptional) continue;
    const source = p.source ?? DEFAULT_SOURCE;
    const resolved: ResolvedSpec = {
      name: normalizeName(p.name),
      spec: pkgSpecString(p),
      source,
      optional: p.optional,
    };
    // CUDA-aware torch (and the torchvision/torchaudio siblings).
    if (CUDA_WHEEL_PACKAGES.has(normalizeName(p.name))) {
      const index = torchCudaIndex(gpu);
      if (index) {
        resolved.indexUrl = index;
        resolved.source = "cuda";
      }
    }
    out.push(resolved);
  }
  return out;
}

// ====================================================================== //
//  §6 batched gate plan — the shape the sidecar stages/scans/installs.   //
// ====================================================================== //

/** One row of a batched gate plan: a spec awaiting (or carrying) a verdict. */
export interface GatePlanItem {
  name: string;
  spec: string;
  source: PkgSource;
  indexUrl?: string;
  optional?: boolean;
}

/**
 * The batched gate plan (file 04 §6 / §7): the full set of specs the GUI shows
 * in wizard step ③ before "Create & scan". The sidecar stages each, runs the
 * REAL nemesis on the staging dir, and installs only the cleared subset; blocked
 * rows are skipped + reported, never fatal to the batch. This is purely the
 * PLAN shape (no verdicts yet) — the engine-bridge attaches GateBadges per item.
 */
export interface BatchedGatePlan {
  items: GatePlanItem[];
  /** count of items (convenience for the "gate N fetches" wizard summary). */
  count: number;
}

/** Build the batched gate plan shape from resolved specs (file 04 §6). */
export function batchedGatePlan(specs: ResolvedSpec[]): BatchedGatePlan {
  const items: GatePlanItem[] = specs.map((s) => ({
    name: s.name,
    spec: s.spec,
    source: s.source,
    ...(s.indexUrl ? { indexUrl: s.indexUrl } : {}),
    ...(s.optional ? { optional: s.optional } : {}),
  }));
  return { items, count: items.length };
}
