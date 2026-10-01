// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
//
// The memory half of the guard (changed 2026-09-22) refuses on REAL pressure, as the kernel
// reports it. It used to refuse below 4 GB of free + speculative pages, but on this 64 GB Mac
// that is the normal state: the file cache keeps free + speculative at 0.9–1.5 GB while the
// kernel reports ~90% of memory free (it only aims to keep 62 MB free). So every scoped run was
// refused for the wrong reason. The rule matches handoffs/mem-guard-lib.sh, which the
// ram-guard and sentinel watchdogs use to decide when to kill a model server.
const MAX_UNSCOPED = 120;
const MIN_KERNEL_FREE_PCT = 25; // kern.memorystatus_level: refuse at or below this
// free + speculative: the fallback floor, used only when the kernel figures cannot be read.
// On its own it is not evidence (loading a large model drains free pages to ~50 MB while the
// kernel still reports ~50% free), and with the kernel readable, level <= 25% already refuses.
const MIN_FREE_FLOOR_MB = 256;
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

// Absolute path: the minimal-PATH case above also drops /usr/sbin.
function sysctlInt(name) {
  const res = spawnSync("/usr/sbin/sysctl", ["-n", name], { encoding: "utf8" });
  if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * ── THE MODEL-RESIDENCY GUARD (added 2026-09-25) ─────────────────────────────────
 *
 * CLAUDE.md §2.1 has always had TWO decision rules, and this script only enforced one.
 *
 *   1. kernel pressure >= 2, or kernel-free <= 25%   -> refuse      [enforced above]
 *   2. llama-server running, or `ollama ps` lists a model -> STOP AND ASK   [prose only]
 *
 * Rule 2 lived exclusively in prose, which means it was enforced by whoever happened to be
 * reading — and on 2026-09-25 an assistant ran a four-package sweep while qwen3.6 (26 GB) was
 * resident, twice, the second time by putting the pre-flight check and the test command in the
 * SAME shell invocation so there was no point at which it could stop. A check that cannot
 * interrupt the thing it is checking is decoration.
 *
 * The hazard is specific and measured: ~20 suites target a live ollama on :11434 (§2.3), and
 * `llama-server` has been observed going 8.7 GB -> 17 GB in two seconds when one lands. Add the
 * fork storm and a model already holding 26 GB, and this is the exact shape of the 2026-09-05
 * episode that drove free memory to 58.9 MB.
 *
 * Refusing rather than warning is deliberate: the memory guard above cannot see this coming,
 * because a resident model does NOT raise kernel pressure until the second allocation starts.
 * A 26 GB model and a healthy-looking 77% free is precisely the state that reads as safe and
 * is not.
 *
 * Its own override, NOT `PROMETHEUS_ALLOW_FULL_SUITE`: that switch disables every check in this
 * block including the memory floor, and a user who deliberately wants a scoped run beside a
 * loaded model should not have to give up the rest of the guard to get it.
 */
const ALLOW_RESIDENT = process.env.PROMETHEUS_ALLOW_MODEL_RESIDENT === "1";

/** What is holding a model right now, or null. Never throws; an unreadable probe means "nothing". */
function modelResidency() {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const held = [];

  // `pgrep -x` matches the executable NAME exactly. `-f` would match any process whose ARGUMENTS
  // merely contain the string — including this guard's own command line, and including the editor
  // that has the word open in a buffer. CLAUDE.md §2.1 calls this out by name.
  for (const name of ["llama-server", "ollama_llama_server"]) {
    const r = spawnSync("/usr/bin/pgrep", ["-xl", name], { encoding: "utf8" });
    if (r.status === 0 && typeof r.stdout === "string" && r.stdout.trim()) {
      held.push(
        ...r.stdout
          .trim()
          .split("\n")
          .map((l) => `process ${l.trim()}`),
      );
    }
  }

  // `ollama ps` is the same question CLAUDE.md's own pre-flight asks. A daemon that is up but
  // idle prints only a header, so the header row is dropped rather than counted.
  const ps = spawnSync("ollama", ["ps"], { encoding: "utf8" });
  if (ps.status === 0 && typeof ps.stdout === "string") {
    const rows = ps.stdout
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const row of rows) held.push(`ollama: ${row.replace(/\s{2,}/g, "  ")}`);
  }

  return held.length > 0 ? held : null;
}

/** Why memory is too tight to start a run, or null. All three figures go in the message. */
function memoryRefusal() {
  if (process.platform !== "darwin") return null;
  // kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical.
  const pressure = sysctlInt("kern.memorystatus_vm_pressure_level");
  const level = sysctlInt("kern.memorystatus_level");
  const freeMB = freeMemMB();
  if (pressure === null || level === null) {
    console.error(
      `run-tests: WARNING — cannot read the kernel memory figures (sysctl); only the ${MIN_FREE_FLOOR_MB} MB free-memory floor is active for this run. Check: memory_pressure -Q`,
    );
  }
  const figures = `pressure=${pressure ?? "?"} kernel-free=${level ?? "?"}% free+speculative=${freeMB} MB`;
  if (pressure !== null && pressure >= 2) {
    return `kernel memory pressure is ${pressure >= 4 ? "critical" : "warning"} (${figures})`;
  }
  if (level !== null && level <= MIN_KERNEL_FREE_PCT) {
    return `kernel reports ${level}% memory free, need more than ${MIN_KERNEL_FREE_PCT}% (${figures})`;
  }
  if ((pressure === null || level === null) && freeMB < MIN_FREE_FLOOR_MB) {
    return `free + speculative is below the ${MIN_FREE_FLOOR_MB} MB floor (${figures})`;
  }
  return null;
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
    (f) => f === ROOT || ROOT.startsWith(`${f}/`) || ROOTS.some((r) => f === join(ROOT, r)),
  );

// A second, unconditional ceiling. `MAX_UNSCOPED` cannot be lowered to catch a novel bypass
// because the run CLAUDE.md recommends — `packages/core` — is itself 153 suites. So the
// whole-tree rule above carries the intent, and this catches anything that slips past it while
// still leaving every real per-package run (largest: apps/desktop, 212) working.
const HARD_MAX_FILES = 260;

if (!OVERRIDE) {
  if (selectsWholeTree && files.length > MAX_UNSCOPED) {
    console.error(
      `run-tests: REFUSING an unscoped run of ${files.length} suites.\n  node:test forks one process per file; this has hard-locked this machine.\n  (Arguments that select the whole tree — ".", "", "..", "apps packages" — are\n   unscoped too, however many of them you pass.)\n  Scope it:   node scripts/run-tests.mjs packages/core\n  Override:   PROMETHEUS_ALLOW_FULL_SUITE=1  (only with ollama/LM Studio stopped)`,
    );
    process.exit(2);
  }
  if (files.length > HARD_MAX_FILES) {
    console.error(
      `run-tests: REFUSING ${files.length} suites in one run (ceiling ${HARD_MAX_FILES}).\n  That is broader than any single package; narrow the path.\n  Override:   PROMETHEUS_ALLOW_FULL_SUITE=1  (only with ollama/LM Studio stopped)`,
    );
    process.exit(2);
  }
  const memWhy = memoryRefusal();
  if (memWhy) {
    console.error(
      `run-tests: REFUSING — ${memWhy}.\n  Check what is holding it:  ollama ps ; pgrep -xl llama-server ; memory_pressure -Q`,
    );
    process.exit(2);
  }
}

// Checked even under PROMETHEUS_ALLOW_FULL_SUITE, because that switch is about the SIZE of the
// run and this hazard is about what else is already in memory. Its own override turns it off.
if (!ALLOW_RESIDENT) {
  const held = modelResidency();
  if (held) {
    console.error(
      [
        "run-tests: REFUSING — a model is resident right now (CLAUDE.md §2.1).",
        ...held.map((h) => `    ${h}`),
        "  ~20 suites target a live ollama on :11434, and llama-server has been measured going",
        "  8.7 GB -> 17 GB in two seconds when one of them lands. A model already holding memory",
        "  plus this runner's fork-per-file is the combination that has taken the display down.",
        "  Note that memory can look healthy here: a resident model does not raise kernel",
        "  pressure until the SECOND allocation starts.",
        "",
        "  Wait for it to unload (ollama's keep-alive is 60s — see handoffs/ollama-safe-limits.sh),",
        "  or stop it deliberately, then re-run.",
        "  Override:   PROMETHEUS_ALLOW_MODEL_RESIDENT=1  (you are choosing to accept this)",
      ].join("\n"),
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
