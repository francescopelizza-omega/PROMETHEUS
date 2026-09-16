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

// ── RESOURCE GUARD (added 2026-09-05 after repeated dev-machine lockups) ─────────
// An UNSCOPED run sweeps ~575 suites and node:test forks ONE PROCESS PER FILE. On the
// 64 GB dev Mac that has driven free memory to ~60 MB and taken the display down with
// it — unified memory means the compositor starves before jetsam kills anything, so the
// screen dies while the kernel keeps running and NOTHING is written to the crash logs.
// Several suites also target a live ollama on :11434, which loads a multi-GB model
// (observed: llama-server 8.7 GB -> 17 GB in two seconds).
// Scope the run. Override only with local model runtimes stopped.
const MAX_UNSCOPED = 120;
const MIN_FREE_MB = 4096;
const OVERRIDE = process.env.PROMETHEUS_ALLOW_FULL_SUITE === "1";

function freeMemMB() {
  if (process.platform !== "darwin") return Number.POSITIVE_INFINITY;
  // `spawnSync` does NOT throw when the binary is missing or the spawn is denied — it returns
  // `{ error, status: null, stdout: null }`. So `.stdout ?? ""` parsed to 0 MB free and REFUSED
  // every run with a completely wrong cause, and the `catch` fail-open below was unreachable.
  // This repo has a documented history of minimal-PATH invocations (a GUI-launched shell), which
  // is exactly when `vm_stat` fails to resolve. Check the result explicitly; the catch stays only
  // as a backstop for an unexpected throw.
  try {
    const res = spawnSync("vm_stat", [], { encoding: "utf8" });
    if (res.error || res.status !== 0 || typeof res.stdout !== "string") {
      const why = res.error?.code ?? `exit ${res.status}`;
      console.error(
        `run-tests: WARNING — cannot read vm_stat (${why}); the free-RAM guard is NOT active for this run. Check it yourself: vm_stat | head -3`,
      );
      return Number.POSITIVE_INFINITY;
    }
    // The page size is REQUIRED from the output rather than defaulted: 16384 is Apple-Silicon
    // specific and would be wrong by 4x on an Intel Mac, in the unsafe direction.
    const pageM = /page size of (\d+)/.exec(res.stdout);
    const freeM = /Pages free:\s+(\d+)/.exec(res.stdout);
    if (!pageM || !freeM) {
      console.error(
        "run-tests: WARNING — vm_stat output not recognised; the free-RAM guard is NOT active " +
          "for this run. Check it yourself: vm_stat | head -3",
      );
      return Number.POSITIVE_INFINITY;
    }
    const spec = Number(/Pages speculative:\s+(\d+)/.exec(res.stdout)?.[1] ?? 0);
    return Math.round(((Number(freeM[1]) + spec) * Number(pageM[1])) / 1048576);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The `--test-concurrency` value: a positive integer, or the safe default 4.
 *
 * `?? 4` was not enough — it only falls back on null/undefined, so an exported-but-empty
 * `PROMETHEUS_TEST_CONCURRENCY=` produced the literal flag `--test-concurrency=` and a typo
 * (`auto`, `4x`) was passed straight through. Node rejects the malformed option and exits before
 * running a single suite; with `stdio: "inherit"` the message reads as unrelated to the variable.
 * This is the documented override in CLAUDE.md §2.3, i.e. a user-facing input.
 */
function testConcurrency() {
  const raw = (process.env.PROMETHEUS_TEST_CONCURRENCY ?? "").trim();
  if (raw === "") return 4;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(
      `run-tests: ignoring PROMETHEUS_TEST_CONCURRENCY="${raw}" (want a positive integer); using 4.`,
    );
    return 4;
  }
  return n;
}

// "Scoped" is a property of WHAT GOT SELECTED, not of whether argv was empty.
//
// The original check was `filters.length === 0 && files.length > MAX_UNSCOPED`, so passing ANY
// argument disabled the cap — including arguments that select the entire tree. Measured:
//   node scripts/run-tests.mjs .              -> 575 files, ~1150 forks, guard SKIPPED
//   node scripts/run-tests.mjs ""             -> 575 files, guard SKIPPED
//   node scripts/run-tests.mjs ..             -> 575 files, guard SKIPPED
//   node scripts/run-tests.mjs apps packages  -> 575 files, guard SKIPPED
// CLAUDE.md tells the reader to scope the run by passing a path, and `.` is a path. The guard
// was one keystroke from off, and `.` is the keystroke people reach for.
//
// A filter equal to the repo root, to an ANCESTOR of it, or to a whole ROOTS entry selects
// everything, so it is treated as unscoped no matter how many argv entries produced it.
const selectsWholeTree =
  filters.length === 0 ||
  filters.some(
    (f) =>
      f === ROOT ||
      ROOT.startsWith(`${f}/`) ||
      ROOTS.some((r) => f === join(ROOT, r)),
  );

// A second, unconditional ceiling. `MAX_UNSCOPED` cannot be lowered to catch a novel bypass
// because the run CLAUDE.md recommends — `packages/core` — is itself 153 suites. So the
// whole-tree rule above carries the intent, and this catches anything that slips past it while
// still leaving every real per-package run (largest: apps/desktop, 212) working.
const HARD_MAX_FILES = 260;

if (!OVERRIDE) {
  if (selectsWholeTree && files.length > MAX_UNSCOPED) {
    console.error(
      `run-tests: REFUSING an unscoped run of ${files.length} suites.\n` +
        `  node:test forks one process per file; this has hard-locked this machine.\n` +
        `  (Arguments that select the whole tree — ".", "", "..", "apps packages" — are\n` +
        `   unscoped too, however many of them you pass.)\n` +
        `  Scope it:   node scripts/run-tests.mjs packages/core\n` +
        `  Override:   PROMETHEUS_ALLOW_FULL_SUITE=1  (only with ollama/LM Studio stopped)`,
    );
    process.exit(2);
  }
  if (files.length > HARD_MAX_FILES) {
    console.error(
      `run-tests: REFUSING ${files.length} suites in one run (ceiling ${HARD_MAX_FILES}).\n` +
        `  That is broader than any single package; narrow the path.\n` +
        `  Override:   PROMETHEUS_ALLOW_FULL_SUITE=1  (only with ollama/LM Studio stopped)`,
    );
    process.exit(2);
  }
  const freeMB = freeMemMB();
  if (freeMB < MIN_FREE_MB) {
    console.error(
      `run-tests: REFUSING — only ${freeMB} MB RAM free, need ${MIN_FREE_MB} MB.\n` +
        `  Check what is holding it:  ollama ps ; pgrep -fl llama-server ; vm_stat | head -5`,
    );
    process.exit(2);
  }
}

console.error(`run-tests: ${files.length} suites via dev-register node:test runner`);
const res = spawnSync(
  process.execPath,
  [
    // Task #10: lets a suite `mock.module("electron", ...)` so a module with a REAL
    // top-level `import { ipcMain } from "electron"` (ide-ipc.ts and its siblings) can
    // be imported + exercised under plain node:test — the installed "electron" npm
    // package here is just a binary-path resolver stub, not the real API surface.
    // No-op (no warning, no behaviour change) for every suite that never calls it.
    `--test-concurrency=${testConcurrency()}`,
    "--experimental-test-module-mocks",
    "--import",
    DEV_REGISTER,
    "--test",
    ...files.map((f) => relative(ROOT, f)),
  ],
  { cwd: ROOT, stdio: "inherit" },
);
process.exit(res.status ?? 1);
