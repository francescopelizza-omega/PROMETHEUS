import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";

import type { FrecencyFs } from "./path-frecency-store.js";
import {
  findProjectRoot,
  loadPathFrecency,
  projectKey,
  recordPathUse,
  savePathFrecency,
} from "./path-frecency-store.js";

/** An in-memory fake fs: a map of path → file content, and a set of dirs (existsSync). */
function fakeFs(files: Record<string, string> = {}, dirs: Set<string> = new Set()): FrecencyFs {
  return {
    existsSync: (p) => dirs.has(p) || p in files,
    readFileSync: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (p, data) => {
      files[p] = data;
    },
    mkdirSync: (p) => {
      dirs.add(p);
    },
  };
}

/* ── findProjectRoot ──────────────────────────────────────────────────────────── */

test("findProjectRoot: walks up to the nearest .git", () => {
  const dirs = new Set(["/repo/.git"]);
  const fs = fakeFs({}, dirs);
  assert.equal(findProjectRoot("/repo/apps/cli/src", fs), "/repo");
});

test("findProjectRoot: falls back to cwd when no .git is found anywhere above it", () => {
  const fs = fakeFs({}, new Set());
  assert.equal(findProjectRoot("/scratch/no-repo-here", fs), "/scratch/no-repo-here");
});

test("findProjectRoot: cwd itself already being the repo root works", () => {
  const dirs = new Set(["/repo/.git"]);
  const fs = fakeFs({}, dirs);
  assert.equal(findProjectRoot("/repo", fs), "/repo");
});

/* ── projectKey ───────────────────────────────────────────────────────────────── */

test("projectKey: deterministic, 16 hex chars, distinct for distinct roots", () => {
  const a = projectKey("/repo/one");
  const b = projectKey("/repo/one");
  const c = projectKey("/repo/two");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

/* ── load / save / record ─────────────────────────────────────────────────────── */

test("loadPathFrecency: a missing store file yields an empty store (fail-soft)", () => {
  const fs = fakeFs();
  const store = loadPathFrecency("/repo", "/home/.prometheus", fs);
  assert.deepEqual(store, { entries: [] });
});

test("loadPathFrecency: a corrupt store file also yields an empty store", () => {
  const home = "/home/.prometheus";
  const files: Record<string, string> = {
    [`${home}/state/path-frecency/${projectKey("/repo")}.json`]: "{ not json",
  };
  const fs = fakeFs(files);
  assert.deepEqual(loadPathFrecency("/repo", home, fs), { entries: [] });
});

test("savePathFrecency then loadPathFrecency round-trips", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  const store = { entries: [{ path: "/repo/src/a.ts", count: 3, lastUsedMs: 1000 }] };
  savePathFrecency("/repo", store, home, fs);
  assert.deepEqual(loadPathFrecency("/repo", home, fs), store);
});

test("savePathFrecency creates the state/path-frecency directory", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  savePathFrecency("/repo", { entries: [] }, home, fs);
  const file = `${home}/state/path-frecency/${projectKey("/repo")}.json`;
  assert.ok(fs.existsSync(dirname(file)));
});

test("savePathFrecency never throws even when the fs is broken", () => {
  const brokenFs: FrecencyFs = {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error("nope");
    },
    writeFileSync: () => {
      throw new Error("disk full");
    },
    mkdirSync: () => {
      throw new Error("EACCES");
    },
  };
  assert.doesNotThrow(() => savePathFrecency("/repo", { entries: [] }, "/home", brokenFs));
});

test("recordPathUse persists an incrementing, round-trippable store", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  recordPathUse("/repo", "/repo/src/a.ts", 1000, home, fs);
  const after = recordPathUse("/repo", "/repo/src/a.ts", 2000, home, fs);
  assert.deepEqual(after.entries, [{ path: "/repo/src/a.ts", count: 2, lastUsedMs: 2000 }]);
  assert.deepEqual(loadPathFrecency("/repo", home, fs), after);
});

test("two different project roots get two independent stores", () => {
  const home = "/home/.prometheus";
  const fs = fakeFs();
  recordPathUse("/repo-a", "/repo-a/x.ts", 1000, home, fs);
  recordPathUse("/repo-b", "/repo-b/y.ts", 1000, home, fs);
  assert.deepEqual(loadPathFrecency("/repo-a", home, fs).entries, [
    { path: "/repo-a/x.ts", count: 1, lastUsedMs: 1000 },
  ]);
  assert.deepEqual(loadPathFrecency("/repo-b", home, fs).entries, [
    { path: "/repo-b/y.ts", count: 1, lastUsedMs: 1000 },
  ]);
});
