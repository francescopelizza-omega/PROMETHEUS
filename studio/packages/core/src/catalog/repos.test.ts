import assert from "node:assert/strict";
/**
 * catalog/repos.test.ts — the Studio Repo-index projection + verdict-ref store (file 06 §3,§7).
 *
 * Covers: sidecar row (snake OR camel) → CatalogRepo, the fail-closed verdict-ref projection
 * (an unrecognised verdict => "error"/BLOCK, never "allow" — C5), the derived display states
 * (clean / blocked / needs-confirm), linking a repo to the catalog item it backs (git_clone
 * installs share the repo's signed verdict), and the last-fetched sort. Fixtures mirror the
 * `repo.py` index entry shape.
 */
import { test } from "node:test";

import { listRowToItem } from "./normalize.js";
import {
  type SidecarRepoRow,
  isBlockedRepo,
  isCleanRepo,
  linkReposToItems,
  needsConfirmRepo,
  toVerdictRef as repoVerdictRef,
  reposByCatalogItem,
  sortReposByFetched,
  toCatalogRepo,
  toCatalogRepos,
  verdictCommit,
} from "./repos.js";

// ── sidecar row -> CatalogRepo ────────────────────────────────────────────────── //

const cleanRow: SidecarRepoRow = {
  id: "yt-dlp-yt-dlp",
  url: "https://github.com/yt-dlp/yt-dlp",
  owner: "yt-dlp",
  name: "yt-dlp",
  local_path: "/home/u/.config/prometheus/repos/yt-dlp-yt-dlp",
  branch: "main",
  last_fetched: "2026-06-14T10:00:00Z",
  status: "cloned",
  verdict_ref: {
    verdict: "allow",
    score: 0,
    signed_at: "2026-06-14T10:00:01Z",
    findings_ref: "gate-audit.jsonl#42",
    commit: "a1b2c3d",
  },
};

test("toCatalogRepo projects snake_case sidecar fields into CatalogRepo", () => {
  const r = toCatalogRepo(cleanRow);
  assert.equal(r.id, "yt-dlp-yt-dlp");
  assert.equal(r.localPath, "/home/u/.config/prometheus/repos/yt-dlp-yt-dlp");
  assert.equal(r.lastFetched, "2026-06-14T10:00:00Z");
  assert.equal(r.status, "cloned");
  assert.equal(r.lastVerdict?.verdict, "allow");
  assert.equal(r.lastVerdict?.findingsRef, "gate-audit.jsonl#42");
  assert.equal(r.commit, "a1b2c3d"); // bound commit from the verdict ref
});

test("toCatalogRepo also accepts camelCase fields (engine-bridge already camels)", () => {
  const r = toCatalogRepo({
    id: "x",
    localPath: "/p",
    lastFetched: "2026-01-01T00:00:00Z",
    pinnedCommit: "deadbee",
    linkedCatalogItemId: "acme-skill",
  });
  assert.equal(r.localPath, "/p");
  assert.equal(r.pinnedCommit, "deadbee");
  assert.equal(r.linkedCatalogItemId, "acme-skill");
});

test("toCatalogRepo defaults missing fields (branch=main, status=cloned)", () => {
  const r = toCatalogRepo({ id: "bare" });
  assert.equal(r.branch, "main");
  assert.equal(r.status, "cloned");
  assert.equal(r.lastVerdict, undefined);
});

// ── verdict ref is FAIL-CLOSED (C5) ───────────────────────────────────────────── //

test("repoVerdictRef fails closed: an unknown verdict => error (BLOCK), never allow", () => {
  assert.equal(repoVerdictRef({ verdict: "totally-bogus" })?.verdict, "error");
  assert.equal(repoVerdictRef({ verdict: "" })?.verdict, "error");
  assert.equal(repoVerdictRef({ verdict: "block" })?.verdict, "block");
  assert.equal(repoVerdictRef(undefined), undefined);
});

test("repoVerdictRef defaults score to 100 (worst) when absent", () => {
  assert.equal(repoVerdictRef({ verdict: "warn" })?.score, 100);
});

test("verdictCommit reads the bound commit", () => {
  assert.equal(verdictCommit({ commit: "abc" }), "abc");
  assert.equal(verdictCommit({}), undefined);
});

// ── derived display states ────────────────────────────────────────────────────── //

test("isBlockedRepo: blocked status OR a block/error verdict", () => {
  assert.equal(isBlockedRepo(toCatalogRepo({ id: "a", status: "blocked" })), true);
  assert.equal(
    isBlockedRepo(toCatalogRepo({ id: "b", status: "cloned", verdict_ref: { verdict: "error" } })),
    true,
  );
  assert.equal(isBlockedRepo(toCatalogRepo(cleanRow)), false);
});

test("isCleanRepo: cloned + allow verdict", () => {
  assert.equal(isCleanRepo(toCatalogRepo(cleanRow)), true);
  assert.equal(isCleanRepo(toCatalogRepo({ id: "x", status: "stale" })), false);
});

test("needsConfirmRepo: warn status or warn verdict", () => {
  assert.equal(needsConfirmRepo(toCatalogRepo({ id: "w", status: "warn" })), true);
  assert.equal(
    needsConfirmRepo(
      toCatalogRepo({ id: "w2", status: "cloned", verdict_ref: { verdict: "warn" } }),
    ),
    true,
  );
  assert.equal(needsConfirmRepo(toCatalogRepo(cleanRow)), false);
});

// ── linking a repo to the catalog item it backs ──────────────────────────────── //

test("reposByCatalogItem indexes only linked repos", () => {
  const repos = toCatalogRepos([
    { id: "r1", linkedCatalogItemId: "acme-skill" },
    { id: "r2" }, // unlinked
  ]);
  const idx = reposByCatalogItem(repos);
  assert.equal(idx.size, 1);
  assert.equal(idx.get("acme-skill")?.id, "r1");
});

test("linkReposToItems binds the backing repo's verdict onto the item (when absent)", () => {
  const item = listRowToItem({ name: "acme-skill", tier: "community" });
  const repos = toCatalogRepos([
    {
      id: "r1",
      linkedCatalogItemId: "acme-skill",
      verdict_ref: { verdict: "allow", score: 0, signed_at: "t" },
    },
  ]);
  const [linked] = linkReposToItems([item], repos);
  assert.equal(linked.state.lastVerdict?.verdict, "allow");
});

test("linkReposToItems: a fresher per-item verdict is NOT overwritten by the repo's", () => {
  const item = {
    ...listRowToItem({ name: "acme-skill" }),
    state: {
      installed: true,
      lastVerdict: { verdict: "warn" as const, score: 10, signedAt: "t2" },
    },
  };
  const repos = toCatalogRepos([
    {
      id: "r1",
      linkedCatalogItemId: "acme-skill",
      verdict_ref: { verdict: "allow", signed_at: "t" },
    },
  ]);
  const [linked] = linkReposToItems([item], repos);
  assert.equal(linked.state.lastVerdict?.verdict, "warn"); // item wins
});

// ── sort by last-fetched (file 06 §3.3 default) ───────────────────────────────── //

test("sortReposByFetched: newest first, missing dates last, ties by id", () => {
  const repos = toCatalogRepos([
    { id: "old", last_fetched: "2026-01-01T00:00:00Z" },
    { id: "new", last_fetched: "2026-06-01T00:00:00Z" },
    { id: "never" }, // no lastFetched -> last
  ]);
  assert.deepEqual(
    sortReposByFetched(repos).map((r) => r.id),
    ["new", "old", "never"],
  );
});
