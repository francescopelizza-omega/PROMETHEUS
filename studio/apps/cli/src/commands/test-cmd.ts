/**
 * commands/test-cmd.ts — `prometheus test <discover|run>` over the testmgr.py sidecar (CLI-007).
 *
 *   discover [path]                    → the discovered test tree (files → cases)
 *   run [path] [--id a,b] [--framework auto|pytest|unittest] [--timeout N]
 *                                      → a per-test results table + failures section
 *
 * The sidecar owns execution + the nemesis-clean spawn (C5/C7); this renders its
 * streamed `{"event":"test",…}` lines (via the runSidecar onEvent seam) into a table
 * and derives HONEST exit codes from the terminal summary envelope — the CLI never
 * re-scores pass/fail from the raw process rc (C5). `--json` emits the raw envelope.
 */
import {
  type FSWatcher,
  watch as fsWatch,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { cliProfiles } from "@prometheus/core";
import { type CoverageReport, computeTotalCoverage, fileCoverage } from "@prometheus/engine-bridge";
import type { CliContext, CommandOutcome } from "../context.js";
import { c } from "../render.js";
import { coverageBar, preferAscii } from "./coverage-view.js";
import {
  type FlakyMemory,
  type RetryOutcome,
  classifyRetry,
  isInconsistent,
  mergeFlaky,
  parseFlakyMemory,
} from "./flaky-detect.js";
import { type SidecarDeps, defaultSidecarDeps, flagStr } from "./sidecar-cmd.js";
import {
  type ReportCase,
  type TestReport,
  toGithubAnnotations,
  toJUnitXml,
} from "./test-report.js";

const VERBS = ["discover", "run", "coverage", "watch"] as const;

/** first positional path (default cwd "."). */
function pathArg(ctx: CliContext): string {
  return ctx.args.positionals[0] ?? ".";
}

function optionShaped(verb: string, p: string): CommandOutcome {
  return {
    text: `prometheus test ${verb}: refusing option-shaped path: ${p}`,
    json: { ok: false, error: "bad-path", path: p },
    exitCode: 2,
  };
}

interface TestNodeLike {
  id?: string;
  kind?: string;
  label?: string;
  children?: TestNodeLike[];
}

/** All leaf case ids under a discovered tree, depth-first. */
function collectCaseIds(tree: unknown): string[] {
  const out: string[] = [];
  const visit = (n: TestNodeLike): void => {
    if (n.kind === "case" && typeof n.id === "string") out.push(n.id);
    for (const child of n.children ?? []) visit(child);
  };
  if (Array.isArray(tree)) for (const n of tree) visit(n as TestNodeLike);
  return out;
}

function renderTreeNode(node: TestNodeLike, indent: string, lines: string[]): void {
  if (node.kind === "case") {
    lines.push(`${indent}${c.dim("•")} ${node.id ?? node.label ?? ""}`);
    return;
  }
  lines.push(`${indent}${c.cyan(node.label ?? node.id ?? "")}`);
  for (const child of node.children ?? []) renderTreeNode(child, `${indent}  `, lines);
}

async function discover(ctx: CliContext, deps: SidecarDeps): Promise<CommandOutcome> {
  const path = pathArg(ctx);
  if (path.startsWith("-")) return optionShaped("discover", path);
  const env = await deps.runSidecar("testmgr.py", ["discover", "--path", path]);
  if (ctx.json) return { json: env, exitCode: env.ok === false ? 2 : 0 };
  if (env.ok === false) {
    return { text: c.red(`test discover failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }
  const tree = Array.isArray(env.tree) ? (env.tree as TestNodeLike[]) : [];
  const lines: string[] = [
    `${c.bold("tests")} ${c.dim(`(${env.fileCount ?? tree.length} files · ${env.caseCount ?? 0} cases)`)}`,
  ];
  for (const file of tree) renderTreeNode(file, "  ", lines);
  if (tree.length === 0) lines.push(c.dim("  (no test files found)"));
  return { text: lines.join("\n"), exitCode: 0 };
}

const GLYPH: Record<string, (s: string) => string> = {
  pass: (s) => c.green(s),
  fail: (s) => c.red(s),
  error: (s) => c.red(s),
  skip: (s) => c.yellow(s),
};
const MARK: Record<string, string> = { pass: "✓", fail: "✗", error: "✖", skip: "○" };

interface RunEvent {
  status: string;
  message?: string;
  file?: string;
  line?: number;
  output?: string[];
}

const numOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Normalize the streamed per-test events + terminal summary into the CI-report shape (CLI-093). */
function buildRunReport(
  order: readonly string[],
  events: ReadonlyMap<string, RunEvent>,
  summary: Record<string, unknown>,
): TestReport {
  const cases: ReportCase[] = [];
  for (const id of order) {
    const ev = events.get(id);
    if (!ev) continue;
    const rc: ReportCase = { id, status: ev.status };
    if (ev.file) rc.file = ev.file;
    if (typeof ev.line === "number") rc.line = ev.line;
    if (ev.message) rc.message = ev.message;
    if (ev.output) rc.output = ev.output;
    cases.push(rc);
  }
  return {
    suiteName: "prometheus test",
    cases,
    summary: {
      total: numOf(summary.total),
      passed: numOf(summary.passed),
      failed: numOf(summary.failed),
      skipped: numOf(summary.skipped),
      ...(typeof summary.durationMs === "number" ? { durationMs: summary.durationMs } : {}),
    },
  };
}

/* ── flaky-test persistence (CLI-094): fs wrapper around the pure merge/parse ── */

function flakyStorePath(home: string = homedir()): string {
  return join(cliProfiles.configDir(home), "flaky-tests.json");
}

/** Read the accumulated flaky memory (fail-soft: missing/corrupt ⇒ {}). */
function readFlakyMemory(home?: string): FlakyMemory {
  try {
    return parseFlakyMemory(readFileSync(flakyStorePath(home), "utf8"));
  } catch {
    return {};
  }
}

/** Persist the flaky memory atomically (tmp + rename); a read-only home just skips it. */
function writeFlakyMemory(mem: FlakyMemory, home: string = homedir()): void {
  try {
    const dir = cliProfiles.configDir(home);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, "flaky-tests.json.tmp");
    writeFileSync(tmp, `${JSON.stringify(mem, null, 2)}\n`);
    renameSync(tmp, flakyStorePath(home));
  } catch {
    /* read-only / full disk → no persistence, never a crash */
  }
}

/** Did a single-id re-run PASS? (summary: no failures AND at least one pass — a missing test ⇒ fail.) */
function reRunPassed(env: Record<string, unknown>): boolean {
  const s = (env.summary ?? {}) as Record<string, unknown>;
  return numOf(s.failed) === 0 && numOf(s.passed) > 0;
}

/**
 * Re-run each initially-failed test `n` times (SAME command each attempt — reproducible policy) and
 * classify from the retry history (CLI-094). Pure fan-out over the injected `runSidecar`; the
 * classification itself lives in the pure flaky-detect module.
 */
async function retryFailures(
  deps: SidecarDeps,
  path: string,
  framework: string,
  failedIds: readonly string[],
  n: number,
): Promise<RetryOutcome[]> {
  const outcomes: RetryOutcome[] = [];
  for (const id of failedIds) {
    const attempts: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const env = await deps.runSidecar("testmgr.py", [
        "run",
        "--path",
        path,
        "--framework",
        framework,
        "--id",
        id,
      ]);
      attempts.push(reRunPassed(env));
    }
    outcomes.push({ id, attempts, classification: classifyRetry(attempts) });
  }
  return outcomes;
}

/** exit 1 on any failure/timeout, else 0 (empty suite = 0); 2 for a launch/usage error. */
function exitFromSummary(env: Record<string, unknown>): number {
  const s = env.summary as Record<string, unknown> | undefined;
  if (!s) return env.ok === false ? 2 : 0;
  if (s.timedOut === true) return 1;
  return typeof s.failed === "number" && s.failed > 0 ? 1 : 0;
}

async function run(ctx: CliContext, deps: SidecarDeps): Promise<CommandOutcome> {
  const path = pathArg(ctx);
  if (path.startsWith("-")) return optionShaped("run", path);

  // repeated `--id` is collapsed by the parser (last wins), so accept a comma list.
  const idFlag = flagStr(ctx, "id");
  let ids = idFlag
    ? idFlag
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  // no ids → enumerate every case via discover (pytest-style node ids).
  let framework = flagStr(ctx, "framework") ?? "auto";
  if (ids.length === 0) {
    const disc = await deps.runSidecar("testmgr.py", ["discover", "--path", path]);
    if (disc.ok === false) {
      return { text: c.red(`test run: discovery failed: ${disc.error ?? "unknown"}`), exitCode: 2 };
    }
    ids = collectCaseIds(disc.tree);
    if (ids.length === 0) {
      const empty = {
        ok: true,
        command: "run",
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      };
      return ctx.json
        ? { json: empty, exitCode: 0 }
        : { text: c.dim("no tests found"), exitCode: 0 };
    }
    // discover emits pytest-style ids (`file::Class::method`); default to pytest so
    // the id format matches (explicit --framework still wins for dotted --id runs).
    if (!flagStr(ctx, "framework")) framework = "pytest";
  }

  const argv = ["run", "--path", path, "--framework", framework];
  for (const id of ids) argv.push("--id", id);
  const timeout = flagStr(ctx, "timeout");
  if (timeout) argv.push("--timeout", timeout);

  const events = new Map<string, RunEvent>();
  const order: string[] = [];
  const env = await deps.runSidecar("testmgr.py", argv, {
    onEvent: (e) => {
      const id = typeof e.id === "string" ? e.id : undefined;
      const status = typeof e.status === "string" ? e.status : undefined;
      if (!id || !status) return;
      if (!events.has(id)) order.push(id);
      const prev = events.get(id) ?? { status };
      const next: RunEvent = { ...prev, status };
      if (typeof e.message === "string") next.message = e.message;
      if (typeof e.file === "string") next.file = e.file;
      if (typeof e.line === "number") next.line = e.line;
      if (Array.isArray(e.output)) next.output = e.output as string[];
      events.set(id, next);
    },
  });

  // CLI-093: build the CI report over the SAME per-test data (no new sidecar fields). `--junit`
  // writes a JUnit-XML file as an ADDITIONAL output (works in --json mode too — a file, not stdout).
  const report = buildRunReport(order, events, (env.summary ?? {}) as Record<string, unknown>);
  const junitPath = flagStr(ctx, "junit");
  let junitNote: string | undefined;
  if (junitPath) {
    if (junitPath.startsWith("-")) return optionShaped("run", junitPath);
    try {
      writeFileSync(junitPath, toJUnitXml(report));
      junitNote = `wrote JUnit XML → ${junitPath}`;
    } catch (e) {
      junitNote = `failed to write JUnit XML: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // CLI-094: `--retry-failed <n>` re-runs ONLY the initially-failed tests + classifies flaky vs
  // genuine vs confirmed-fixed. A flaky result is NEVER silently upgraded to pass — the exit stays
  // non-zero unless `--tolerate-flaky`; a genuine failure is always non-zero.
  const retryFlag = flagStr(ctx, "retry-failed");
  const tolerateFlaky = ctx.args.flags["tolerate-flaky"] === true;
  let retryOutcomes: RetryOutcome[] | undefined;
  let retryExit: number | undefined;
  if (retryFlag && /^\d+$/.test(retryFlag)) {
    const n = Math.min(Math.max(1, Number(retryFlag)), 20);
    const failedIds = order.filter((id) => {
      const st = events.get(id)?.status;
      return st === "fail" || st === "error";
    });
    if (failedIds.length > 0) {
      retryOutcomes = await retryFailures(deps, path, framework, failedIds, n);
      // persist the newly-observed flaky (inconsistent) tests so recurrence is visible over time.
      const flakyIds = retryOutcomes
        .filter((o) => isInconsistent(o.classification))
        .map((o) => o.id);
      if (flakyIds.length > 0) {
        writeFlakyMemory(mergeFlaky(readFlakyMemory(), flakyIds, new Date().toISOString()));
      }
      const genuine = retryOutcomes.some((o) => o.classification === "genuine-fail");
      const inconsistent = retryOutcomes.some((o) => isInconsistent(o.classification));
      retryExit = genuine ? 1 : inconsistent ? (tolerateFlaky ? 0 : 1) : 0;
    }
  }

  if (ctx.json) {
    // --retry-failed is opt-in ⇒ adding `retry` never alters the plain `run --json` shape (CLI-007).
    const jsonEnv = retryOutcomes ? { ...env, retry: retryOutcomes } : env;
    return { json: jsonEnv, exitCode: retryExit ?? exitFromSummary(env) };
  }

  if (env.ok === false && env.summary === undefined) {
    return { text: c.red(`test run failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }

  const s = (env.summary ?? {}) as Record<string, number | boolean>;
  const lines: string[] = [];
  for (const id of order) {
    const ev = events.get(id);
    if (!ev) continue;
    const mark = (GLYPH[ev.status] ?? ((x: string) => x))(MARK[ev.status] ?? "?");
    lines.push(`  ${mark} ${id}`);
  }
  // failures section: file:line + captured output for each fail/error.
  const failures = order.filter((id) => {
    const st = events.get(id)?.status;
    return st === "fail" || st === "error";
  });
  if (failures.length > 0) {
    lines.push("", c.bold("failures:"));
    for (const id of failures) {
      const ev = events.get(id);
      if (!ev) continue;
      lines.push(`  ${c.red("✗")} ${id}`);
      if (ev.file) lines.push(`    ${c.dim(`${ev.file}${ev.line ? `:${ev.line}` : ""}`)}`);
      const detail = ev.message ?? ev.output?.slice(0, 6).join("\n    ");
      if (detail) lines.push(`    ${detail}`);
    }
  }
  const dur = typeof s.durationMs === "number" ? ` · ${s.durationMs}ms` : "";
  const timedOut = s.timedOut === true ? c.red(" · TIMED OUT") : "";
  lines.push(
    "",
    `${c.green(`${s.passed ?? 0} passed`)} · ${c.red(`${s.failed ?? 0} failed`)} · ` +
      `${c.yellow(`${s.skipped ?? 0} skipped`)} · ${s.total ?? 0} total${dur}${timedOut}`,
  );
  // CLI-094: the distinct flaky bucket + per-attempt retry history (never a silent pass/fail).
  if (retryOutcomes) {
    lines.push("", c.bold("retry results (--retry-failed):"));
    for (const o of retryOutcomes) {
      const hist = o.attempts.map((p) => (p ? c.green("✓") : c.red("✗"))).join("");
      const tag =
        o.classification === "flaky"
          ? c.yellow("⚡ FLAKY")
          : o.classification === "confirmed-fixed"
            ? c.yellow("⚡ FLAKY (passed every retry)")
            : c.red("✗ FAIL (genuine)");
      lines.push(`  ${tag} ${o.id}  ${c.dim(`[${hist}]`)}`);
    }
    if (retryExit === 0 && tolerateFlaky) {
      lines.push(c.dim("flaky tolerated (--tolerate-flaky) → exit 0"));
    }
  }
  if (junitNote) lines.push("", c.dim(junitNote));
  // CLI-093: GitHub Actions annotations — explicit flag OR auto-detected in CI (no-op elsewhere).
  const wantAnnotations =
    ctx.args.flags["github-annotations"] === true || process.env.GITHUB_ACTIONS === "true";
  if (wantAnnotations) for (const line of toGithubAnnotations(report)) lines.push(line);
  return { text: lines.join("\n"), exitCode: retryExit ?? exitFromSummary(env) };
}

/**
 * `prometheus test coverage [path]` — run the suite under coverage.py (the dedicated APP-086 sidecar,
 * NOT a testmgr verb) → a per-file coverage table + total. Like `run`, EXECUTING the suite IS the
 * explicit user action, so it runs directly (no preview gate); an option-shaped path is refused.
 * A missing `coverage` package surfaces the pip remedy + exit 2. `--json` passes the envelope through.
 */
async function coverage(ctx: CliContext, deps: SidecarDeps): Promise<CommandOutcome> {
  const path = pathArg(ctx);
  if (path.startsWith("-")) return optionShaped("coverage", path);
  const framework = flagStr(ctx, "framework") ?? "pytest";
  const argv = ["run", "--path", path, "--framework", framework];
  const python = flagStr(ctx, "python");
  if (python) argv.push("--python", python);

  const env = await deps.runSidecar("coverage.py", argv);
  if (ctx.json) return { json: env, exitCode: env.ok === false ? 2 : 0 };
  if (env.ok === false) {
    // the sidecar's error already names the pip remedy when coverage is absent (acceptance #2).
    return { text: c.red(`test coverage failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }

  // shape the envelope into the frozen CoverageReport contract (no cast widening) + render.
  const perFile = (env.perFile ?? {}) as CoverageReport["perFile"];
  const report: CoverageReport = {
    perFile,
    totalPct: typeof env.totalPct === "number" ? env.totalPct : 0,
  };
  const rows = Object.entries(report.perFile)
    .map(([file, entry]) => ({
      file,
      pct: Math.round(fileCoverage(entry) * 1000) / 10,
      missed: entry.missed.length,
    }))
    .sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file)); // worst coverage first

  const total = computeTotalCoverage(report);
  const lines: string[] = [
    `${c.bold("coverage")} ${c.dim(`(${rows.length} files · ${total}% total)`)}`,
  ];
  if (rows.length === 0) lines.push(c.dim("  (no files measured)"));
  // CLI-095: a fixed-width coverage bar column, tinted by the SAME 90/60 thresholds as the pct.
  const ascii = preferAscii();
  for (const r of rows) {
    const tint = r.pct >= 90 ? c.green : r.pct >= 60 ? c.yellow : c.red;
    const bar = coverageBar(r.pct, 10, { ascii });
    lines.push(
      `  ${tint(bar)}  ${tint(`${r.pct.toFixed(1)}%`.padStart(6))}  ${r.file}${r.missed ? c.dim(` · ${r.missed} missed`) : ""}`,
    );
  }
  const suiteExit = typeof env.suiteExit === "number" ? env.suiteExit : 0;
  // the suite failing is NOT a coverage error (report is still valid); note it but exit 0.
  if (suiteExit !== 0)
    lines.push(
      "",
      c.yellow(
        `⚠ suite exited ${suiteExit} (tests failed or none collected) — coverage of what ran`,
      ),
    );
  return { text: lines.join("\n"), exitCode: 0 };
}

/* ==========================================================================
 * `prometheus test watch [path]` — re-run affected tests on file change (CLI-092).
 *
 * A long-running loop until `q`/Ctrl-C. Every seam (watcher, keys, timers, clock,
 * write, tty) is injected via WatchIo so the whole orchestration is unit-testable
 * with NO real fs.watch / raw stdin / wall-clock. Pure helpers (mapper, ignore
 * rules, summary format) are exported + tested directly.
 * ======================================================================== */

const DEBOUNCE_MS = 250;
const KEY_Q = 0x71;
const KEY_CTRL_C = 0x03;
const SHOW_CURSOR = "\x1b[?25h";

/** Dirs/files the watcher ignores — a missed `node_modules` = thousands of spurious watchers. */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "coverage",
  ".venv",
  "__pycache__",
]);

/** Ignore a watched basename: known heavy dirs, any dotfile/dot-dir, and *.log noise. */
export function shouldIgnoreWatch(name: string): boolean {
  if (IGNORE_DIRS.has(name)) return true;
  if (name.startsWith(".")) return true; // dotfiles + dot-dirs
  if (name.endsWith(".log")) return true;
  return false;
}

/** The test-file "stem" (`foo.test.ts`→`foo`, `test_foo.py`→`foo`, `foo_test.py`→`foo`), or null. */
export function testFileStem(path: string): string | null {
  const base = basename(path);
  let m = base.match(/^(.*)\.(test|spec)\.[^.]+$/);
  if (m) return m[1] ?? null;
  m = base.match(/^test_(.*)\.py$/);
  if (m) return m[1] ?? null;
  m = base.match(/^(.*)_test\.py$/);
  if (m) return m[1] ?? null;
  return null;
}

/** A source file's stem (basename minus its final extension). */
function sourceStem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

/**
 * Map changed files → the test files to re-run (CLI-092). A changed TEST file runs itself; a
 * changed SOURCE file runs the known test whose stem matches its basename. `unsure` is true when
 * NO confident target was found (⇒ the caller does one full run). Pure — `known` is the discovered
 * test-file list.
 */
export function mapChangedToTests(
  changed: readonly string[],
  known: readonly string[],
): { targets: string[]; unsure: boolean } {
  const targets = new Set<string>();
  for (const f of changed) {
    if (testFileStem(f) !== null) {
      targets.add(f); // a changed test file runs itself
      continue;
    }
    const stem = sourceStem(f);
    const hit = known.find((k) => testFileStem(k) === stem);
    if (hit) targets.add(hit);
  }
  return { targets: [...targets], unsure: targets.size === 0 };
}

/** The per-cycle summary line: `\r`-rewritten on a TTY (no newline), a plain appended line piped. */
export function formatSummaryLine(
  cycle: number,
  files: number,
  r: { passed: number; failed: number; skipped: number },
  durationMs: number,
  tty: boolean,
): string {
  const body =
    `cycle ${cycle} · ${files} file${files === 1 ? "" : "s"} · ` +
    `${c.green(`${r.passed}✓`)} ${c.red(`${r.failed}✗`)} ${c.yellow(`${r.skipped}○`)} · ${durationMs}ms`;
  return tty ? `\r${body}` : `${body}\n`;
}

/** The injected side-effect seams for the watch loop (defaults = real fs/stdin/timers). */
export interface WatchIo {
  /** watch `root`; call `onChange(absPathOrNull)` per fs event (null filename ⇒ rescan). */
  createWatcher: (root: string, onChange: (file: string | null) => void) => { close: () => void };
  /** register a raw-mode key handler; `restore` undoes raw mode + shows the cursor. */
  onKey: (handler: (byte: number) => void) => { restore: () => void };
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  write: (s: string) => void;
  isTTY: boolean;
  now: () => number;
}

/** Extract the discovered test FILE paths (top-level tree nodes) for the change→test mapper. */
function discoverTestFiles(env: Record<string, unknown>): string[] {
  const tree = Array.isArray(env.tree) ? (env.tree as TestNodeLike[]) : [];
  return tree
    .map((n) => (typeof n.id === "string" ? n.id : n.label))
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * `prometheus test watch [path]` (CLI-092). Fails fast on `--json` (streaming JSON is out of scope, exit 2)
 * BEFORE any watcher opens; guards an option-shaped path; then watches + re-runs affected tests until
 * `q`/Ctrl-C, which tears down every watcher + aborts any in-flight run in ONE shared teardown.
 */
export async function runWatch(
  ctx: CliContext,
  deps: SidecarDeps = defaultSidecarDeps,
  io: WatchIo = defaultWatchIo(),
): Promise<CommandOutcome> {
  if (ctx.json) {
    return {
      text: "prometheus test watch: --json streaming is not supported (out of scope)",
      json: { ok: false, error: "watch-json-unsupported" },
      exitCode: 2,
    };
  }
  const path = pathArg(ctx);
  if (path.startsWith("-")) return optionShaped("watch", path);

  // discover the known test files once (for change→test mapping + the full-run fallback set).
  const disc = await deps.runSidecar("testmgr.py", ["discover", "--path", path]);
  const known = disc.ok === false ? [] : discoverTestFiles(disc);

  return new Promise<CommandOutcome>((resolve) => {
    let cycle = 0;
    let pending = new Set<string>();
    let debounce: unknown = null;
    let inflight: AbortController | null = null;
    let closed = false;

    const teardown = (): void => {
      if (closed) return;
      closed = true;
      if (debounce !== null) io.clearTimer(debounce);
      inflight?.abort(); // kill any in-flight sidecar → no zombie python survives quit
      watcher.close();
      keys.restore();
    };

    const runCycle = async (): Promise<void> => {
      if (closed) return;
      const changed = [...pending].filter((f) => f !== "*");
      const rescan = pending.has("*");
      pending = new Set();
      inflight?.abort(); // a new cycle supersedes the prior in-flight run
      const ac = new AbortController();
      inflight = ac;
      cycle++;

      const { targets, unsure } = mapChangedToTests(changed, known);
      const full = rescan || unsure;
      if (unsure && !rescan) io.write(`${c.dim("mapping unsure → full run")}\n`);
      const runPaths = full ? [path] : targets;

      let passed = 0;
      let failed = 0;
      let skipped = 0;
      const t0 = io.now();
      for (const rp of runPaths) {
        if (ac.signal.aborted) return;
        const env = await deps.runSidecar(
          "testmgr.py",
          ["run", "--path", rp, "--framework", "auto"],
          {
            signal: ac.signal,
          },
        );
        const s = (env.summary ?? {}) as Record<string, number>;
        passed += s.passed ?? 0;
        failed += s.failed ?? 0;
        skipped += s.skipped ?? 0;
      }
      if (ac.signal.aborted) return;
      io.write(
        formatSummaryLine(
          cycle,
          runPaths.length,
          { passed, failed, skipped },
          io.now() - t0,
          io.isTTY,
        ),
      );
      if (inflight === ac) inflight = null;
    };

    const onChange = (file: string | null): void => {
      if (closed) return;
      pending.add(file ?? "*"); // null filename ⇒ rescan sentinel
      if (debounce !== null) io.clearTimer(debounce);
      // trailing-edge debounce: collapse a save burst (rename+change+temp) into ONE run.
      debounce = io.setTimer(() => {
        debounce = null;
        void runCycle();
      }, DEBOUNCE_MS);
    };

    const onKey = (byte: number): void => {
      if (byte === KEY_Q || byte === KEY_CTRL_C) {
        teardown();
        io.write("\n");
        resolve({ exitCode: 0 });
      }
    };

    const watcher = io.createWatcher(path, onChange);
    const keys = io.onKey(onKey);
    io.write(`${c.dim(`watching ${path} — press q to quit`)}\n`);
  });
}

/** Default watch seams: recursive fs.watch (with a manual per-dir walk fallback for Linux), raw
 *  stdin keys, and real timers. Not unit-tested (integration/manual); the loop logic is tested via
 *  an injected fake WatchIo. */
function defaultWatchIo(): WatchIo {
  return {
    createWatcher: (root, onChange) => {
      const watchers: FSWatcher[] = [];
      const watched = new Set<string>();
      let recursiveFallback = false;
      // A non-recursive per-dir watcher reports `filename` RELATIVE TO ITS OWN DIR, so the changed
      // path must be joined against the dir that fired (not always `root`) — else a nested change on
      // Linux resolves to a phantom top-level path and the edited test is never re-run.
      const emit = (base: string, filename: string | Buffer | null): void => {
        const name = filename ? filename.toString() : null;
        if (name && shouldIgnoreWatch(basename(name))) return;
        const abs = name ? join(base, name) : null;
        onChange(abs);
        // Linux fallback only: a NEWLY-created directory must start being watched too (recursive
        // fs.watch does this natively; the manual walk must catch up on the create event).
        if (abs && recursiveFallback) {
          try {
            if (!watched.has(abs) && statSync(abs).isDirectory()) walk(abs);
          } catch {
            /* not a dir / already removed — ignore */
          }
        }
      };
      const walk = (dir: string): void => {
        if (watched.has(dir)) return;
        watched.add(dir);
        try {
          watchers.push(fsWatch(dir, (_ev, fn) => emit(dir, fn)));
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory() || shouldIgnoreWatch(entry.name)) continue;
            walk(join(dir, entry.name));
          }
        } catch {
          /* unreadable dir — skip it, never crash the watcher */
        }
      };
      try {
        watchers.push(fsWatch(root, { recursive: true }, (_ev, fn) => emit(root, fn)));
      } catch {
        recursiveFallback = true;
        walk(root); // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM (Linux) → manual per-dir walk
      }
      return {
        close: () => {
          for (const w of watchers) {
            try {
              w.close();
            } catch {
              /* already closed */
            }
          }
        },
      };
    },
    onKey: (handler) => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw ?? false;
      stdin.setRawMode?.(true);
      stdin.resume();
      const listener = (buf: Buffer): void => {
        for (const byte of buf) handler(byte);
      };
      stdin.on("data", listener);
      return {
        restore: () => {
          stdin.off("data", listener);
          stdin.setRawMode?.(wasRaw);
          stdin.pause();
          process.stdout.write(SHOW_CURSOR); // never leave the terminal in raw/no-cursor state
        },
      };
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    write: (s) => process.stdout.write(s),
    isTTY: process.stdout.isTTY === true,
    now: () => Date.now(),
  };
}

/** `prometheus test <discover|run|coverage|watch>` — dispatch. */
export async function runTest(
  ctx: CliContext,
  deps: SidecarDeps = defaultSidecarDeps,
): Promise<CommandOutcome> {
  const verb = ctx.args.command[1];
  if (verb === "discover") return discover(ctx, deps);
  if (verb === "run") return run(ctx, deps);
  if (verb === "coverage") return coverage(ctx, deps);
  if (verb === "watch") return runWatch(ctx, deps);
  return {
    text: `prometheus test: unknown verb ${verb ? `"${verb}"` : "(none)"} — valid: ${VERBS.join(", ")}`,
    json: { ok: false, error: "unknown-verb", valid: VERBS },
    exitCode: 2,
  };
}
