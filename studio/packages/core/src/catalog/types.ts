// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * catalog/types.ts — the Studio-side data models for the catalog surface (file 06 §2).
 *
 * These are PROJECTIONS of engine reality, not a parallel source of truth. The engine
 * (`prometheus.py`) stays authoritative for installed-state; `normalize.ts` projects the
 * raw engine JSON into these shapes and `reconcile.ts` merges live `status`/`inventory`
 * truth back in. The verdict model is NOT redefined here — `NemesisVerdictRef` is the C3
 * shape re-exported from `@prometheus/engine-bridge` (the single source of truth, file 03).
 *
 * Naming note: `domain/models.ts` already carries a MINIMAL legacy `Repo`/`CatalogItem`
 * (the M1 generic scan row). These file-06 §2 shapes are the RICHER catalog-manager
 * vocabulary; the core index re-exports them under a `Catalog*` namespace so both coexist.
 */

import type { NemesisVerdictRef } from "@prometheus/engine-bridge";

export type { NemesisVerdictRef } from "@prometheus/engine-bridge";

/** Catalog tier — mirrors `Plugin.tier` + the registry the item came from. */
export type CatalogTier = "official" | "community" | "devtool" | "documented";

/** Which engine registry/subcommand owns this item's lifecycle. */
export type CatalogKind =
  | "plugin" // PLUGINS  -> list/install/uninstall/enable/disable/status/audit/where/matrix/sync
  | "skill" // SKILL.md -> skills (list/enable/disable/mute) + scaffold-skill + sync
  | "app" // REPO_TOOLS -> apps  (4th fn)
  | "worldsim" // worldsim engines -> worldsim (8th fn)
  | "model-tool" // MODEL_TOOLS -> models (3rd fn)  [serving handed to 05-model-hub]
  | "pentest" // PENTEST_TOOLS -> pentest (5th fn) [ROE-gated; surfaced via 09]
  | "repo"; // a raw GitHub clone the user added (Studio-managed, §3)

/** A reach cell value (plugin reach across an agent, from `matrix`). */
export type ReachCell = "native" | "sync" | "-";

/** Install reach scope (long form; distinct from matrix's compact "C"/"U"). */
export type CatalogScope = "claude-only" | "universal";

/** A selectable sub-unit of a plugin (drives the `:sel` / `--only` / `--skip` install). */
export interface CatalogComponent {
  id: string;
  kind: string;
}

/** A row in any catalog tab. Superset; fields populate per-kind. */
export interface CatalogItem {
  id: string; // engine `name`/`id` (stable key for all commands)
  kind: CatalogKind;
  tier: CatalogTier;
  title: string; // Plugin.name / RepoTool.name
  summary: string;
  category?: string; // Plugin.category / RepoTool.category
  // provenance
  repo?: string; // "owner/repo" (Plugin.repo) or full URL (RepoTool.repo)
  owner?: string;
  license?: string;
  stars?: number;
  forks?: number;
  // ranking & grouping
  recommendRank?: number; // 0 official, 1..N community
  redundancyGroup?: string; // de-dupe families (A_code_graph, ...)
  bundle?: boolean; // part of one-run official bundle
  // reach (plugins only)
  scope?: CatalogScope;
  reach?: Record<string, ReachCell>; // from matrix
  components?: CatalogComponent[]; // selectable sub-units (:sel / --only)
  installsSkills?: boolean;
  // guidance (verbatim from engine — never paraphrase a security_note)
  automation?: string;
  securityNote?: string;
  caveats?: string[];
  postInstallNote?: string;
  // hard gates
  installable: boolean; // false for tier="documented" -> Install action absent
  docUrl?: string; // DOCUMENTED_ONLY.doc_url
  whyExcluded?: string; // DOCUMENTED_ONLY.why_excluded
  supportedOs: ("macos" | "linux" | "windows")[];
  // live state (reconciled from `status` / `apps status` / `skills list`)
  state: InstallState;
}

/** Per-agent install/enable state for a plugin (from `status`/`inventory`). */
export interface PerAgentState {
  agent: string;
  installed: boolean;
  enabled: boolean;
  method: string;
  dest?: string;
}

/**
 * Present (engine confirms it on disk), absent (engine confirms it is NOT), or unknown (the
 * engine cannot statically determine it — e.g. a `shell` installer with no marker). Drives the
 * green ✓ / red ✗ / neutral status mark in the GUI catalog, the install panel, and the CLI
 * `/invoke` picker. NEVER coerce unknown → absent (that would paint a false red ✗).
 */
export type InstallPresence = "present" | "absent" | "unknown";

/** Live install state, reconciled from `status` / `apps status` / `skills list`. */
export interface InstallState {
  installed: boolean;
  /** tri-state presence for the status mark (present ✓ / absent ✗ / unknown ·). */
  presence?: InstallPresence;
  enabled?: boolean; // settings.json / on-disk arm state
  perAgent?: PerAgentState[];
  installedVersion?: string; // apps/worldsim versioned trees
  availableVersions?: string[]; // apps versions / worldsim tags (for rollback UI)
  running?: boolean; // apps/worldsim compose stacks
  port?: string;
  lastVerdict?: NemesisVerdictRef; // from the last audit/install gate (see 03)
}

/** Where a tool lands, per-target, BEFORE installing (drives the dry-run preview). */
export interface InstallTarget {
  agent: string; // "*" = universal fan-out, or host name
  method: string; // InstallSpec.method
  dest: string; // _where_dest()
  mcpName?: string;
  repoUrl?: string;
  universalAdd?: string;
}

/** The live, derived status of a Studio-managed repo (mirrors the sidecar's index). */
export type RepoStatus = "cloned" | "stale" | "blocked" | "dirty" | "missing" | "warn";

/** A raw GitHub repo the user manages in Studio (file 06 §2, FEATURE #5a / §3). */
export interface CatalogRepo {
  id: string; // slug derived from URL
  url: string; // https / ssh
  owner: string;
  name: string;
  localPath: string; // clone dir under ~/.config/prometheus/repos/<id>
  pinnedCommit?: string; // explicit pin; null = track branch
  branch: string;
  commit?: string; // the currently-checked-out commit
  lastFetched?: string; // ISO
  lastVerdict?: NemesisVerdictRef; // verdict bound to the cloned commit (engine trust.json)
  status: RepoStatus;
  linkedCatalogItemId?: string; // if this repo backs a catalog install (git_clone method)
}

/**
 * The file-06 §2 alias. The plan calls this type `Repo`, but `domain/models.ts` already
 * exports a (different, minimal) `Repo`. The canonical file-06 catalog repo is
 * `CatalogRepo`; the core index re-exports it as `CatalogRepo` so both survive.
 */
export type Repo = CatalogRepo;
