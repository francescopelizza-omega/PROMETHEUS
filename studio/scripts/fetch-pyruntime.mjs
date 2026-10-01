// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * scripts/fetch-pyruntime.mjs — fetch + verify + strip the relocatable CPython (file 10 §3.1).
 *
 * Because prometheus.py AND nemesis are stdlib-only, we ship Astral's prebuilt,
 * checksummed `python-build-standalone` (no PyInstaller freeze). For each os-arch
 * target we: download the pinned tarball, VERIFY its sha256 against pyruntime.lock.json
 * (supply-chain gate — §3.1/§10), unpack to staging/pyruntime/<os>-<arch>/, and STRIP
 * test/idlelib/tkinter/turtledemo/ensurepip/__pycache__ (~40MB → ~18MB). The unpacked
 * runtime is itself `nemesis scan`'d in CI before a release (§3.1).
 *
 * Modes:
 *   node scripts/fetch-pyruntime.mjs [--target <os-arch>]   fetch+verify+strip (default: host)
 *   node scripts/fetch-pyruntime.mjs --write-lock           fetch all, compute+write sha256
 *   node scripts/fetch-pyruntime.mjs --verify               fail if any target sha256 is empty
 *
 * Network + tar are required at build time only; this file is pure config logic
 * otherwise. The download/extract are done with node stdlib (fetch + tar via the OS
 * `tar`); a missing target tarball is a loud, fail-closed error.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const studio = resolve(here, "..");
const lockPath = join(studio, "pyruntime.lock.json");

/** Directories stripped from the unpacked runtime to shrink it (§3.1). */
export const STRIP_DIRS = ["test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip"];

/** True if a path inside the unpacked runtime should be removed during strip. */
export function shouldStrip(relPath) {
  const parts = relPath.split(/[/\\]/);
  return parts.some((seg) => seg === "__pycache__" || STRIP_DIRS.includes(seg));
}

/** Read + parse the lock (throws loudly if missing/invalid — the pin is mandatory). */
export function readLock() {
  return JSON.parse(readFileSync(lockPath, "utf8"));
}

/** The download URL for a target (python-build-standalone asset naming). */
export function assetUrl(lock, target) {
  const t = lock.targets[target];
  if (!t) throw new Error(`unknown pyruntime target "${target}"`);
  const file = `cpython-${lock.python}+${lock.release}-${t.triple}-${lock.flavor}.tar.gz`;
  return `${lock.source}/releases/download/${lock.release}/${file}`;
}

function hostTarget() {
  // os names MUST match electron-builder's `${os}` file macro (mac/linux/windows) so the
  // staged dir === electron-builder.yml's `from: ../../staging/pyruntime/${os}-${arch}` (APP-068).
  const os =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Extract a .tar.gz to a dir using the OS tar (stdlib has no gzip-tar extractor). */
function extractTarGz(tarPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync("tar", ["-xzf", tarPath, "-C", destDir, "--strip-components", "1"], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`tar extract failed for ${tarPath}`);
}

function stripRuntime(dir) {
  // Walk + remove stripped dirs (node:fs has no rm-by-predicate).
  const walk = (d, rel) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (shouldStrip(r)) {
        rmSync(full, { recursive: true, force: true });
        continue;
      }
      if (statSync(full).isDirectory()) walk(full, r);
    }
  };
  walk(dir, "");
}

async function fetchTarget(lock, target, { writeLock } = {}) {
  const url = assetUrl(lock, target);
  const dest = join(studio, "staging", "pyruntime", target);
  console.log(`fetch-pyruntime: ${target} ← ${url}`);
  const buf = await download(url);
  const digest = sha256(buf);
  const pinned = lock.targets[target].sha256;
  if (writeLock) {
    lock.targets[target].sha256 = digest;
  } else if (!pinned) {
    throw new Error(`pyruntime ${target}: no pinned sha256 (run --write-lock first)`);
  } else if (pinned !== digest) {
    throw new Error(`pyruntime ${target}: sha256 mismatch\n  pinned ${pinned}\n  got    ${digest}`);
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(studio, "staging", `${target}.tar.gz`);
  writeFileSync(tmp, buf);
  extractTarGz(tmp, dest);
  rmSync(tmp, { force: true });
  stripRuntime(dest);
  console.log(`fetch-pyruntime: ${target} ready (${digest.slice(0, 12)}…)`);
}

async function main() {
  const args = process.argv.slice(2);
  const lock = readLock();

  if (args.includes("--verify")) {
    const empty = Object.entries(lock.targets).filter(([, t]) => !t.sha256);
    if (empty.length > 0) {
      console.error(
        `pyruntime.lock.json: ${empty.length} target(s) missing sha256: ${empty.map(([k]) => k).join(", ")}`,
      );
      process.exit(1);
    }
    console.log("pyruntime.lock.json: all targets pinned ✓");
    return;
  }

  const writeLock = args.includes("--write-lock");
  const targetFlag = args.indexOf("--target");
  const targets = writeLock
    ? Object.keys(lock.targets)
    : targetFlag >= 0
      ? [args[targetFlag + 1]]
      : [hostTarget()];

  let pinned = 0;
  for (const target of targets) {
    try {
      await fetchTarget(lock, target, { writeLock });
      pinned += 1;
    } catch (err) {
      // In --write-lock a missing/404 asset (e.g. a triple the release never published) must
      // WARN + skip, not abort the whole pin — the other targets still get committed. Outside
      // --write-lock (a real packaging fetch) a failure stays fatal (fail-closed).
      if (!writeLock) throw err;
      console.warn(`fetch-pyruntime: SKIP ${target} — ${err.message}`);
    }
  }
  if (writeLock) {
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`wrote sha256 for ${pinned}/${targets.length} target(s) → ${lockPath}`);
  }
}

if (process.argv[1]?.endsWith("fetch-pyruntime.mjs")) {
  main().catch((err) => {
    console.error(`fetch-pyruntime: ${err.message}`);
    process.exit(1);
  });
}
