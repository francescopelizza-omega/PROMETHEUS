// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * catalog/repos.ts — the Studio Repo-index projection + verdict-ref store (file 06 §3, §7).
 *
 * IMPORTANT ownership note: the ON-DISK index (`~/.config/prometheus/repos/index.json`) is
 * OWNED + WRITTEN by the `repo.py` SIDECAR (it stages → gates → promotes → writes the entry,
 * binding the signed verdict ref to the cloned commit). To keep a SINGLE writer of that file
 * (and avoid TOCTOU/merge races), core does NOT re-write it here. Instead this module is the
 * PURE projection layer: it maps the sidecar's camelCased `Repo` rows (from
 * `engine-bridge` `repoList()`/`repoClone()`/…) into the file-06 §2 `CatalogRepo` shape, derives
 * the display status, links a repo to the catalog item it backs, and exposes the verdict-ref
 * (the engine SIGNED it — we store the ref, never recompute, C5).
 *
 * Framework-free + I/O-free: no fs, no spawning. The desktop main / CLI call the engine-bridge
 * repo client; this layer shapes + reconciles what comes back.
 */

import type { NemesisVerdictRef } from "@prometheus/engine-bridge";

import type { CatalogItem, CatalogRepo, InstallState, RepoStatus } from "./types.js";

// ── the sidecar row shape (camelCased by engine-bridge repo.ts) ────────────────

/** A repo row as the engine-bridge `repo.py` client returns it (snake OR camel tolerated). */
export interface SidecarRepoRow {
  id?: string;
  url?: string;
  owner?: string;
  name?: string;
  localPath?: string;
  local_path?: string;
  branch?: string;
  pinnedCommit?: string;
  pinned_commit?: string;
  commit?: string;
  lastFetched?: string;
  last_fetched?: string;
  status?: string;
  linkedCatalogItemId?: string;
  linked_catalog_item_id?: string;
  lastVerdict?: VerdictRefRow;
  last_verdict?: VerdictRefRow;
  verdictRef?: VerdictRefRow;
  verdict_ref?: VerdictRefRow;
}

interface VerdictRefRow {
  verdict?: string;
  score?: number;
  signedAt?: string;
  signed_at?: string;
  findingsRef?: string;
  findings_ref?: string;
  commit?: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────────

const KNOWN_STATUS = new Set<RepoStatus>([
  "cloned",
  "stale",
  "blocked",
  "dirty",
  "missing",
  "warn",
]);

function toStatus(raw: unknown): RepoStatus {
  const s = String(raw ?? "cloned") as RepoStatus;
  return KNOWN_STATUS.has(s) ? s : "cloned";
}

function pick(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

const KNOWN_VERDICTS = new Set(["allow", "warn", "block", "error"]);

/** Project a sidecar verdict-ref row into the C3 `NemesisVerdictRef` (we store the ref, C5). */
export function toVerdictRef(raw: VerdictRefRow | undefined): NemesisVerdictRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = String(raw.verdict ?? "").toLowerCase();
  // fail-closed: an unrecognised/absent verdict is treated as a BLOCK ("error"), never "allow".
  const verdict = (KNOWN_VERDICTS.has(v) ? v : "error") as NemesisVerdictRef["verdict"];
  return {
    verdict,
    score: typeof raw.score === "number" ? raw.score : 100,
    signedAt: pick(raw.signedAt, raw.signed_at) ?? "",
    findingsRef: pick(raw.findingsRef, raw.findings_ref),
  };
}

/** The bound commit a verdict ref was signed against (file 06 §2 Repo.lastVerdict commit). */
export function verdictCommit(raw: VerdictRefRow | undefined): string | undefined {
  return raw && typeof raw.commit === "string" ? raw.commit : undefined;
}

// ── sidecar row → CatalogRepo ───────────────────────────────────────────────────

/** Project one sidecar index row into the file-06 §2 `CatalogRepo`. Pure, total. */
export function toCatalogRepo(row: SidecarRepoRow): CatalogRepo {
  const verdictRow = row.lastVerdict ?? row.last_verdict ?? row.verdictRef ?? row.verdict_ref;
  return {
    id: String(row.id ?? ""),
    url: String(row.url ?? ""),
    owner: String(row.owner ?? ""),
    name: String(row.name ?? ""),
    localPath: pick(row.localPath, row.local_path) ?? "",
    branch: String(row.branch ?? "main"),
    pinnedCommit: pick(row.pinnedCommit, row.pinned_commit),
    commit: pick(row.commit, verdictCommit(verdictRow)),
    lastFetched: pick(row.lastFetched, row.last_fetched),
    lastVerdict: toVerdictRef(verdictRow),
    status: toStatus(row.status),
    linkedCatalogItemId: pick(row.linkedCatalogItemId, row.linked_catalog_item_id),
  };
}

/** Project the whole sidecar index into `CatalogRepo[]`. */
export function toCatalogRepos(rows: SidecarRepoRow[] | undefined): CatalogRepo[] {
  return (rows ?? []).map(toCatalogRepo);
}

// ── derived display state ───────────────────────────────────────────────────────

/**
 * Whether a repo should render with the "force-required" deep-red affordance (file 06 §3.3):
 * a blocked status OR a block/error verdict ref. JS never DECIDES this — it READS the engine's
 * signed verdict (C5).
 */
export function isBlockedRepo(repo: CatalogRepo): boolean {
  if (repo.status === "blocked") return true;
  const v = repo.lastVerdict?.verdict;
  return v === "block" || v === "error";
}

/** Whether the repo is cleanly promoted (status cloned + an allow verdict). */
export function isCleanRepo(repo: CatalogRepo): boolean {
  return repo.status === "cloned" && repo.lastVerdict?.verdict === "allow";
}

/** Whether the repo is awaiting a human confirm (a warn verdict kept staged, file 06 §3.1). */
export function needsConfirmRepo(repo: CatalogRepo): boolean {
  return repo.status === "warn" || repo.lastVerdict?.verdict === "warn";
}

// ── linking a repo to the catalog item it backs (git_clone installs) ────────────

/**
 * Index repos by their `linkedCatalogItemId` so a catalog card backed by a `git_clone` install
 * (file 06 §2 Repo.linkedCatalogItemId) can surface its repo's verdict + path. A repo with no
 * link is skipped.
 */
export function reposByCatalogItem(repos: CatalogRepo[]): Map<string, CatalogRepo> {
  const idx = new Map<string, CatalogRepo>();
  for (const r of repos) {
    if (r.linkedCatalogItemId) idx.set(r.linkedCatalogItemId, r);
  }
  return idx;
}

/**
 * For catalog items installed via `git_clone`, bind the backing repo's signed verdict ref onto
 * the item's install state (so the card shows the same verdict the repo carries). The item's
 * own reconciled install flag is untouched; only `lastVerdict` is enriched when absent.
 */
export function linkReposToItems(items: CatalogItem[], repos: CatalogRepo[]): CatalogItem[] {
  const byItem = reposByCatalogItem(repos);
  return items.map((it) => {
    const repo = byItem.get(it.id);
    if (!repo || !repo.lastVerdict) return it;
    if (it.state.lastVerdict) return it; // a fresher per-item gate wins
    const state: InstallState = { ...it.state, lastVerdict: repo.lastVerdict };
    return { ...it, state };
  });
}

// ── sort (file 06 §3.3 default: last-fetched) ───────────────────────────────────

/**
 * Sort repos for the Repo Manager list (file 06 §3.3 default `sort: last-fetched`):
 * most-recently-fetched first; missing `lastFetched` sorts last; ties by id. Pure, NEW array.
 */
export function sortReposByFetched(repos: CatalogRepo[]): CatalogRepo[] {
  return [...repos].sort((a, b) => {
    const ta = a.lastFetched ? Date.parse(a.lastFetched) : Number.NEGATIVE_INFINITY;
    const tb = b.lastFetched ? Date.parse(b.lastFetched) : Number.NEGATIVE_INFINITY;
    if (ta !== tb) return tb - ta; // newest first
    return a.id.localeCompare(b.id);
  });
}
