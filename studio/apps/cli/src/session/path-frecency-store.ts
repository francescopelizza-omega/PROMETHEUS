// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/path-frecency-store.ts — the per-project "most-used @-path" memory (opt-in;
 * toggled by the `/tab-complete` slash command, persisted as the CLI's own
 * `completion.pathFrecency` flag in home.ts's settings blob).
 *
 * The scoring/eviction math (top-20, recency decay) lives in
 * @prometheus/core/path-completion — this file is only the on-disk I/O + "which
 * project am I in" plumbing, mirroring home.ts's fail-soft, injected-fs conventions.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  EMPTY_FRECENCY_STORE,
  type FrecencyStore,
  parseFrecencyStore,
  recordPathUse as recordPathUseInStore,
} from "@prometheus/core/path-completion";

import { prometheusHome } from "../home.js";

/** The fs surface this store needs (injected in tests). */
export interface FrecencyFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string) => void;
}

const defaultFs: FrecencyFs = {
  existsSync,
  readFileSync: (p) => readFileSync(p, "utf8"),
  writeFileSync: (p, data) => writeFileSync(p, data),
  mkdirSync: (p) => mkdirSync(p, { recursive: true }),
};

/**
 * Walk up from `cwd` looking for a `.git` directory; falls back to `cwd` itself when none
 * is found (e.g. a scratch dir outside any repo) — every project still gets a stable,
 * distinct frecency file, it just won't survive moving that scratch dir elsewhere.
 */
export function findProjectRoot(
  cwd: string,
  fs: Pick<FrecencyFs, "existsSync"> = defaultFs,
): string {
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd; // reached the filesystem root — no repo found
    dir = parent;
  }
}

/** A short, filesystem-safe key for a project root: its CONTENT hashed, not its literal
 *  path, so spaces/unicode/length never matter. A collision would only mean two projects
 *  briefly share suggestions — astronomically unlikely at 16 hex chars of SHA-256. */
export function projectKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function storeFile(root: string, home: string): string {
  return join(home, "state", "path-frecency", `${projectKey(root)}.json`);
}

/** Load this project's frecency store (fail-soft → empty; never throws). */
export function loadPathFrecency(
  root: string,
  home: string = prometheusHome(),
  fs: FrecencyFs = defaultFs,
): FrecencyStore {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(root, home))) as unknown;
    return parseFrecencyStore(raw);
  } catch {
    return EMPTY_FRECENCY_STORE;
  }
}

/** Persist this project's frecency store. Never throws — a failed write costs one lost
 *  usage sample, not a crash mid-session. */
export function savePathFrecency(
  root: string,
  store: FrecencyStore,
  home: string = prometheusHome(),
  fs: FrecencyFs = defaultFs,
): void {
  try {
    fs.mkdirSync(dirname(storeFile(root, home)));
    fs.writeFileSync(storeFile(root, home), `${JSON.stringify(store, null, 2)}\n`);
  } catch {
    /* best-effort — a lost frecency sample is not worth surfacing to the user. */
  }
}

/** Record a use of `absolutePath` under `root`'s store, persisting + returning the result. */
export function recordPathUse(
  root: string,
  absolutePath: string,
  nowMs: number,
  home: string = prometheusHome(),
  fs: FrecencyFs = defaultFs,
): FrecencyStore {
  const next = recordPathUseInStore(loadPathFrecency(root, home, fs), absolutePath, nowMs);
  savePathFrecency(root, next, home, fs);
  return next;
}
