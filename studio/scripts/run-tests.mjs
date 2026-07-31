/**
 * scripts/run-tests.mjs — the ONE working node:test entry point for the whole
 * monorepo (file 02 §7.4 / task receipt). It runs every `*.test.ts(x)` straight
 * from TypeScript source via the dev-register resolver hook (apps/cli/
 * dev-resolver.mjs), so:
 *   - NO build step is required (Node 20+ strips types; the resolver maps the
 *     `@prometheus/*` bare specifiers + the TS `.js`->`.ts` import convention),
 *   - NO `tsx` / `vitest` / installed node_modules are required (none are present
 *     in this environment — the 264 node:test cases must keep passing on stdlib).
 *
 * This is what `pnpm run test` (root) and each package's `test` script delegate
 * to, keeping the runner SINGLE-SOURCED. Vitest is the documented FUTURE unit
 * runner (file 02 §2) once the toolchain is installed — it does NOT gate today.
 *
 * Usage:
 *   node scripts/run-tests.mjs              # all suites
 *   node scripts/run-tests.mjs packages/core   # only suites under a path prefix
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEV_REGISTER = join(ROOT, "apps", "cli", "dev-register.mjs");

// `e2e` holds Playwright `*.spec.ts` specs (APP-069) that import `@playwright/test` and drive
// a real Electron process — they use Playwright's OWN runner, must NEVER be swept into node:test
// (the import + `_electron.launch` would choke here). The `.test.tsx?` glob already excludes the
// `.spec.ts` suffix, and pruning the dir is the belt-and-suspenders guard.
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release", ".git", "coverage", "e2e"]);
const ROOTS = ["packages", "apps"];

/** Recursively collect *.test.ts / *.test.tsx under a directory. */
function collect(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(join(dir, e.name), acc);
    } else if (/\.test\.tsx?$/.test(e.name)) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

// optional path-prefix filter(s) from argv
const filters = process.argv.slice(2).map((p) => resolve(ROOT, p));

let files = [];
for (const r of ROOTS) {
  const base = join(ROOT, r);
  try {
    if (statSync(base).isDirectory()) collect(base, files);
  } catch {
    /* dir may not exist */
  }
}
if (filters.length) {
  files = files.filter((f) => filters.some((flt) => f === flt || f.startsWith(`${flt}/`)));
}
files.sort();

if (files.length === 0) {
  console.error("run-tests: no *.test.ts(x) files matched.");
  process.exit(1);
}

console.error(`run-tests: ${files.length} suites via dev-register node:test runner`);
const res = spawnSync(
  process.execPath,
  ["--import", DEV_REGISTER, "--test", ...files.map((f) => relative(ROOT, f))],
  { cwd: ROOT, stdio: "inherit" },
);
process.exit(res.status ?? 1);
