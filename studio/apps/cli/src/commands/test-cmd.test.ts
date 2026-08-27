/**
 * test-cmd.test.ts — `prometheus test discover/run` with an injected fake runSidecar
 * (no real python spawn). Covers the results table, exit-code matrix, --json
 * passthrough, argv construction, and discover-tree rendering (CLI-007).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CliContext } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import { runHelp } from "./help.js";
import type { SidecarDeps } from "./sidecar-cmd.js";
import {
  type WatchIo,
  formatSummaryLine,
  mapChangedToTests,
  runTest,
  runWatch,
  shouldIgnoreWatch,
  testFileStem,
} from "./test-cmd.js";

setColorEnabled(false);

function makeCtx(
  command: string[],
  positionals: string[] = [],
  flags: Record<string, string | true> = {},
  json = false,
  unmatchedSub?: string,
): CliContext {
  return {
    client: undefined as unknown as CliContext["client"],
    json,
    args: { command, positionals, flags, json, unmatchedSub } as unknown as ParsedArgs,
  };
}

function fakeDeps(opts: {
  discover?: Record<string, unknown>;
  runEvents?: Record<string, unknown>[];
  runEnv?: Record<string, unknown>;
}): { deps: SidecarDeps; calls: { script: string; argv: string[] }[] } {
  const calls: { script: string; argv: string[] }[] = [];
  const deps: SidecarDeps = {
    runSidecar: (async (
      script: string,
      argv: string[],
      o?: { onEvent?: (e: Record<string, unknown>) => void },
    ) => {
      calls.push({ script, argv });
      if (argv[0] === "discover") {
        return (
          opts.discover ?? { ok: true, command: "discover", tree: [], fileCount: 0, caseCount: 0 }
        );
      }
      for (const e of opts.runEvents ?? []) o?.onEvent?.(e);
      return (
        opts.runEnv ?? {
          ok: true,
          command: "run",
          summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        }
      );
    }) as SidecarDeps["runSidecar"],
  };
  return { deps, calls };
}

test("a typo'd verb names the ACTUAL typo, not '(none)' — regression for unmatchedSub", async () => {
  // command[1] is undefined for a TWO_WORD mismatch (parse.ts sets `unmatchedSub` instead),
  // so this used to render "unknown verb (none)" instead of naming the typo.
  const { deps, calls } = fakeDeps({});
  const out = await runTest(makeCtx(["test"], [], {}, false, "dicover"), deps);
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /unknown verb "dicover"/);
  assert.equal(calls.length, 0);
});

test("run: 2 pass + 1 fail → table with counts, failure file:line, exit 1", async () => {
  const { deps } = fakeDeps({
    runEvents: [
      { event: "test", id: "t.a", status: "pass" },
      { event: "test", id: "t.b", status: "pass" },
      { event: "test", id: "t.c", status: "fail" },
      {
        event: "test",
        id: "t.c",
        status: "fail",
        output: ["E AssertionError: 1 != 2"],
        file: "t.py",
        line: 9,
      },
    ],
    runEnv: {
      ok: true,
      command: "run",
      summary: { total: 3, passed: 2, failed: 1, skipped: 0, durationMs: 12 },
    },
  });
  const out = await runTest(makeCtx(["test", "run"], ["fix"], { id: "t.a,t.b,t.c" }), deps);
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /2 passed/);
  assert.match(out.text ?? "", /1 failed/);
  assert.match(out.text ?? "", /✓ t\.a/);
  assert.match(out.text ?? "", /✗ t\.c/);
  assert.match(out.text ?? "", /t\.py:9/);
  assert.match(out.text ?? "", /failures:/);
});

test("run: all-pass → exit 0", async () => {
  const { deps } = fakeDeps({
    runEvents: [
      { event: "test", id: "t.a", status: "pass" },
      { event: "test", id: "t.b", status: "pass" },
    ],
    runEnv: { ok: true, command: "run", summary: { total: 2, passed: 2, failed: 0, skipped: 0 } },
  });
  const out = await runTest(makeCtx(["test", "run"], ["fix"], { id: "t.a,t.b" }), deps);
  assert.equal(out.exitCode, 0);
});

test("run: --timeout kill → timedOut summary → exit 1", async () => {
  const { deps, calls } = fakeDeps({
    runEvents: [],
    runEnv: {
      ok: false,
      command: "run",
      error: "run timed out after 1s",
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, timedOut: true },
    },
  });
  const out = await runTest(makeCtx(["test", "run"], ["fix"], { id: "t.a", timeout: "1" }), deps);
  assert.equal(out.exitCode, 1);
  assert.ok(calls[0]?.argv.includes("--timeout") && calls[0]?.argv.includes("1"));
});

test("run --json emits the raw envelope; stats match; exit reflects failure", async () => {
  const env = { ok: true, command: "run", summary: { total: 3, passed: 2, failed: 1, skipped: 0 } };
  const { deps } = fakeDeps({ runEnv: env, runEvents: [] });
  const out = await runTest(makeCtx(["test", "run"], ["fix"], { id: "t.a" }, true), deps);
  assert.deepEqual(out.json, env);
  assert.equal(out.exitCode, 1);
  assert.equal((out.json as typeof env).summary.failed, 1);
});

test("run: no --id enumerates via discover, then runs pytest-style ids", async () => {
  const { deps, calls } = fakeDeps({
    discover: {
      ok: true,
      command: "discover",
      tree: [
        { kind: "file", label: "test_x.py", children: [{ kind: "case", id: "test_x.py::test_a" }] },
      ],
      fileCount: 1,
      caseCount: 1,
    },
    runEvents: [{ event: "test", id: "test_x.py::test_a", status: "pass" }],
    runEnv: { ok: true, command: "run", summary: { total: 1, passed: 1, failed: 0, skipped: 0 } },
  });
  const out = await runTest(makeCtx(["test", "run"], ["fix"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal(calls[0]?.argv[0], "discover");
  const runCall = calls[1];
  assert.ok(runCall?.argv.includes("--id") && runCall?.argv.includes("test_x.py::test_a"));
  assert.ok(runCall?.argv.includes("pytest"), "enumerated ids default to the pytest framework");
});

test("run: empty suite → exit 0 with a notice", async () => {
  const { deps } = fakeDeps({
    discover: { ok: true, command: "discover", tree: [], fileCount: 0, caseCount: 0 },
  });
  const out = await runTest(makeCtx(["test", "run"], ["fix"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /no tests/);
});

test("discover: renders the tree + counts", async () => {
  const { deps } = fakeDeps({
    discover: {
      ok: true,
      command: "discover",
      tree: [
        { kind: "file", label: "test_x.py", children: [{ kind: "case", id: "test_x.py::test_a" }] },
      ],
      fileCount: 1,
      caseCount: 1,
    },
  });
  const out = await runTest(makeCtx(["test", "discover"], ["fix"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /1 files/);
  assert.match(out.text ?? "", /test_x\.py/);
  assert.match(out.text ?? "", /test_a/);
});

test("unknown/absent verb → exit 1 listing valid verbs", async () => {
  const { deps } = fakeDeps({});
  const out = await runTest(makeCtx(["test"]), deps); // `prometheus test` / `prometheus test bogus`
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /discover, run/);
});

test("option-shaped path is refused before the sidecar (exit 2)", async () => {
  const { deps, calls } = fakeDeps({});
  const out = await runTest(makeCtx(["test", "run"], ["--help"], { id: "t.a" }), deps);
  assert.equal(out.exitCode, 2);
  assert.equal(calls.length, 0, "must not spawn on an option-shaped path");
});

test("`test` appears in `prometheus help` (json command list)", () => {
  const out = runHelp(makeCtx(["help"], [], {}, true));
  const cmds = (out.json as { commands: string[] }).commands;
  assert.ok(cmds.includes("test"), "help must list the test command");
});

// ── CLI-055: prometheus test coverage (wraps the coverage.py sidecar, APP-086) ─────────
/** A coverage.py-keyed fake: `coverage.py` → covEnv; else the run/discover defaults. */
function covDeps(covEnv: Record<string, unknown>): {
  deps: SidecarDeps;
  calls: { script: string; argv: string[] }[];
} {
  const calls: { script: string; argv: string[] }[] = [];
  const deps: SidecarDeps = {
    runSidecar: (async (script: string, argv: string[]) => {
      calls.push({ script, argv });
      return script === "coverage.py"
        ? covEnv
        : { ok: true, command: "run", summary: { total: 0, passed: 0, failed: 0, skipped: 0 } };
    }) as SidecarDeps["runSidecar"],
  };
  return { deps, calls };
}

test("coverage: per-file table (pct + missed) + total, worst-first, exit 0 (CLI-055)", async () => {
  const env = {
    ok: true,
    command: "run",
    perFile: {
      "a.py": { lines: [1, 2, 3, 4], missed: [] }, // 100%
      "b.py": { lines: [1], missed: [2, 3] }, // 33.3%
    },
    totalPct: 62.5,
    suiteExit: 0,
  };
  const { deps, calls } = covDeps(env);
  const out = await runTest(makeCtx(["test", "coverage"], ["pkg"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal(calls[0]?.script, "coverage.py");
  assert.deepEqual(calls[0]?.argv, ["run", "--path", "pkg", "--framework", "pytest"]);
  const text = out.text ?? "";
  // worst coverage first: b.py (33.3%) before a.py (100%)
  assert.ok(text.indexOf("b.py") < text.indexOf("a.py"), "worst coverage rendered first");
  assert.match(text, /33\.3%/);
  assert.match(text, /100\.0%/);
  assert.match(text, /2 missed/);
  // total is recomputed from perFile via computeTotalCoverage: 5 covered / 7 total = 71.4%.
  assert.match(text, /71\.4% total/);
});

test("CLI-095: coverage table gains a per-file bar column (unicode or ascii per locale)", async () => {
  const prev = process.env.LANG;
  process.env.LANG = "en_US.UTF-8"; // force the unicode bar deterministically
  try {
    const env = {
      ok: true,
      command: "run",
      perFile: {
        "a.py": { lines: [1, 2, 3, 4], missed: [] }, // 100% → full bar
        "b.py": { lines: [1], missed: [2, 3] }, // 33.3% → partial bar
      },
      totalPct: 62.5,
      suiteExit: 0,
    };
    const { deps } = covDeps(env);
    const out = await runTest(makeCtx(["test", "coverage"], ["pkg"]), deps);
    const text = out.text ?? "";
    // the bar is an ADDED column on the SAME table (pct/missed still present) — full block for 100%.
    assert.match(text, /██████████/); // a.py at 100%
    assert.match(text, /░/); // b.py is partially empty
    assert.match(text, /100\.0%/); // pct column unchanged
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: restore env exactly
      delete process.env.LANG;
    } else {
      process.env.LANG = prev;
    }
  }
});

test("coverage: missing coverage pkg → remedy + exit 2 (CLI-055)", async () => {
  const env = {
    ok: false,
    command: "run",
    error:
      "the 'coverage' package is not installed in the target env — install it: python3 -m pip install coverage",
  };
  const { deps } = covDeps(env);
  const out = await runTest(makeCtx(["test", "coverage"], ["pkg"]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /pip install coverage/);
});

test("coverage --json passes the envelope through unmodified (CLI-055)", async () => {
  const env = {
    ok: true,
    command: "run",
    perFile: { "a.py": { lines: [1], missed: [] } },
    totalPct: 100,
  };
  const { deps } = covDeps(env);
  const out = await runTest(makeCtx(["test", "coverage"], ["pkg"], {}, true), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.json, env);
});

test("coverage: a failing suite still reports coverage (exit 0, warns) (CLI-055)", async () => {
  const env = {
    ok: true,
    command: "run",
    perFile: { "a.py": { lines: [1], missed: [2] } },
    totalPct: 50,
    suiteExit: 1,
  };
  const { deps } = covDeps(env);
  const out = await runTest(makeCtx(["test", "coverage"], ["pkg"]), deps);
  assert.equal(out.exitCode, 0); // suite failure is not a coverage error
  assert.match(out.text ?? "", /suite exited 1/);
});

/* ── CLI-092: watch mode ─────────────────────────────────────────────────────── */

test("CLI-092 mapChangedToTests: test file runs itself; source maps to its sibling test; unsure→full", () => {
  const known = ["tests/test_foo.py", "src/bar.test.ts", "src/baz_test.py"];
  // a changed test file runs itself
  assert.deepEqual(mapChangedToTests(["tests/test_foo.py"], known), {
    targets: ["tests/test_foo.py"],
    unsure: false,
  });
  // a changed source maps to its stem-matching known test (foo.py → test_foo.py)
  assert.deepEqual(mapChangedToTests(["src/foo.py"], known), {
    targets: ["tests/test_foo.py"],
    unsure: false,
  });
  // bar.ts → bar.test.ts
  assert.deepEqual(mapChangedToTests(["src/bar.ts"], known).targets, ["src/bar.test.ts"]);
  // a source with no matching test → unsure (caller does a full run)
  assert.deepEqual(mapChangedToTests(["src/lonely.ts"], known), { targets: [], unsure: true });
});

test("CLI-092 testFileStem + shouldIgnoreWatch pure rules", () => {
  assert.equal(testFileStem("a/foo.test.ts"), "foo");
  assert.equal(testFileStem("a/foo.spec.tsx"), "foo");
  assert.equal(testFileStem("t/test_foo.py"), "foo");
  assert.equal(testFileStem("t/foo_test.py"), "foo");
  assert.equal(testFileStem("src/foo.ts"), null);
  for (const d of ["node_modules", ".git", "dist", "out", "coverage", ".hidden", "debug.log"]) {
    assert.equal(shouldIgnoreWatch(d), true, `should ignore ${d}`);
  }
  assert.equal(shouldIgnoreWatch("src"), false);
});

test("CLI-092 formatSummaryLine: TTY \\r-rewrite (no newline) vs piped plain line", () => {
  const tty = formatSummaryLine(1, 1, { passed: 2, failed: 0, skipped: 1 }, 5, true);
  assert.ok(tty.startsWith("\r"));
  assert.ok(!tty.endsWith("\n"));
  const piped = formatSummaryLine(3, 2, { passed: 1, failed: 1, skipped: 0 }, 9, false);
  assert.ok(!piped.includes("\r"));
  assert.ok(piped.endsWith("\n"));
  assert.match(piped, /cycle 3 · 2 files/);
});

/** A fake WatchIo the test drives: emit change/key events + flush the (fake) debounce timer. */
function fakeWatchIo() {
  let onChange: ((f: string | null) => void) | null = null;
  let onKey: ((b: number) => void) | null = null;
  const timers: Array<{ fn: () => void; live: boolean }> = [];
  const state = { writes: [] as string[], closed: 0, restored: 0 };
  const io: WatchIo = {
    createWatcher: (_root, cb) => {
      onChange = cb;
      return { close: () => state.closed++ };
    },
    onKey: (h) => {
      onKey = h;
      return { restore: () => state.restored++ };
    },
    setTimer: (fn) => {
      const t = { fn, live: true };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      if (h) (h as { live: boolean }).live = false;
    },
    write: (s) => state.writes.push(s),
    isTTY: false,
    now: () => 0,
  };
  return {
    io,
    state,
    emitChange: (f: string | null) => onChange?.(f),
    emitKey: (b: number) => onKey?.(b),
    // fire the single live (trailing-edge) debounce timer + let its async cycle settle.
    flush: async () => {
      for (const t of timers) {
        if (t.live) {
          t.live = false;
          t.fn();
        }
      }
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/** watch-mode deps: records run argv + optional per-run gate so a run can be held "in flight". */
function watchDeps(opts: { known?: string[]; hold?: () => Promise<void> } = {}) {
  const runs: { path: string; signal?: AbortSignal }[] = [];
  const tree = (opts.known ?? []).map((id) => ({ id, kind: "file", children: [] }));
  const deps: SidecarDeps = {
    runSidecar: (async (_script: string, argv: string[], o?: { signal?: AbortSignal }) => {
      if (argv[0] === "discover") return { ok: true, command: "discover", tree };
      // argv: run --path <p> --framework auto
      runs.push({ path: argv[2] ?? "", signal: o?.signal });
      if (opts.hold) await opts.hold();
      return { ok: true, command: "run", summary: { total: 1, passed: 1, failed: 0, skipped: 0 } };
    }) as SidecarDeps["runSidecar"],
  };
  return { deps, runs };
}

test("CLI-092 --json + watch → exit 2 WITHOUT opening any watcher (fail fast)", async () => {
  const drive = fakeWatchIo();
  const { deps, runs } = watchDeps();
  const out = await runWatch(makeCtx(["test", "watch"], ["pkg"], {}, true), deps, drive.io);
  assert.equal(out.exitCode, 2);
  assert.equal(drive.state.closed, 0, "no watcher opened");
  assert.equal(runs.length, 0, "no sidecar run");
});

test("CLI-092 debounce: 3 rapid saves of one test file → exactly ONE sidecar run", async () => {
  const drive = fakeWatchIo();
  const { deps, runs } = watchDeps({ known: ["tests/test_foo.py"] });
  const done = runWatch(makeCtx(["test", "watch"], ["pkg"]), deps, drive.io);
  await new Promise((r) => setTimeout(r, 0)); // let discover settle + watcher register
  drive.emitChange("tests/test_foo.py");
  drive.emitChange("tests/test_foo.py");
  drive.emitChange("tests/test_foo.py");
  await drive.flush();
  assert.equal(runs.length, 1, "coalesced to one run");
  assert.equal(runs[0]?.path, "tests/test_foo.py");
  drive.emitKey(0x71); // q
  assert.equal((await done).exitCode, 0);
});

test("CLI-092 unmappable change → exactly one FULL run with the fallback notice", async () => {
  const drive = fakeWatchIo();
  const { deps, runs } = watchDeps({ known: ["tests/test_foo.py"] });
  const done = runWatch(makeCtx(["test", "watch"], ["pkg"]), deps, drive.io);
  await new Promise((r) => setTimeout(r, 0));
  drive.emitChange("src/lonely.ts"); // no matching test
  await drive.flush();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.path, "pkg", "full run over the watch root");
  assert.match(drive.state.writes.join(""), /mapping unsure → full run/);
  drive.emitKey(0x03); // Ctrl-C
  await done;
});

test("CLI-092 q quits: closes the watcher, restores raw mode, aborts the in-flight run (no zombie)", async () => {
  let release!: () => void;
  const drive = fakeWatchIo();
  const { deps, runs } = watchDeps({
    known: ["tests/test_foo.py"],
    hold: () =>
      new Promise<void>((r) => {
        release = r;
      }), // the run hangs until released
  });
  const done = runWatch(makeCtx(["test", "watch"], ["pkg"]), deps, drive.io);
  await new Promise((r) => setTimeout(r, 0));
  drive.emitChange("tests/test_foo.py");
  await drive.flush(); // starts the run, which now hangs in `hold`
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.signal?.aborted, false);
  drive.emitKey(0x71); // q while the run is in flight
  assert.equal((await done).exitCode, 0);
  assert.equal(drive.state.closed, 1, "watcher closed exactly once");
  assert.equal(drive.state.restored, 1, "raw mode restored exactly once");
  assert.equal(runs[0]?.signal?.aborted, true, "in-flight run aborted → no zombie sidecar");
  release(); // let the held run settle (no unhandled rejection)
});

test("CLI-092 watch listed in help synopsis", () => {
  const out = runHelp(makeCtx(["help"], ["test"]));
  assert.match(out.text ?? "", /watch/);
});

/* ── CLI-093: JUnit-XML + GitHub-annotations export ──────────────────────────────── */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

const failRun = {
  runEvents: [
    { event: "test", id: "tests/t.py::test_ok", status: "pass" },
    {
      event: "test",
      id: "tests/t.py::test_bad",
      status: "fail",
      file: "tests/t.py",
      line: 7,
      message: "AssertionError: 1 != 2",
    },
  ],
  runEnv: {
    ok: true,
    command: "run",
    summary: { total: 2, passed: 1, failed: 1, skipped: 0, durationMs: 33 },
  },
};

test("CLI-093 --junit writes a schema-valid JUnit-XML file (in addition to the human table)", async () => {
  const { deps } = fakeDeps(failRun);
  const dir = mkdtempSync(pathJoin(tmpdir(), "prom-junit-"));
  const file = pathJoin(dir, "report.xml");
  try {
    const out = await runTest(makeCtx(["test", "run"], ["tests/"], { id: "a", junit: file }), deps);
    assert.equal(out.exitCode, 1); // a failure → exit 1 (unchanged)
    assert.match(out.text ?? "", /wrote JUnit XML/);
    const xml = readFileSync(file, "utf8");
    assert.match(xml, /<testsuites tests="2" failures="1"/);
    assert.match(
      xml,
      /<testcase name="test_bad"[^>]*>\s*<failure message="AssertionError: 1 != 2"/,
    );
    assert.match(xml, /<testcase name="test_ok"[^>]*\/>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI-093 --junit does NOT alter the raw --json envelope (still the sidecar object)", async () => {
  const { deps } = fakeDeps(failRun);
  const dir = mkdtempSync(pathJoin(tmpdir(), "prom-junit2-"));
  const file = pathJoin(dir, "r.xml");
  try {
    const out = await runTest(
      makeCtx(["test", "run"], ["tests/"], { id: "a", junit: file }, true),
      deps,
    );
    // --json passthrough is unchanged: exactly the sidecar envelope, no report fields injected.
    assert.deepEqual(out.json, failRun.runEnv);
    // the file is still written as an additional side output.
    assert.match(readFileSync(file, "utf8"), /<testsuites/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI-093 --github-annotations emits ::error lines for failures", async () => {
  const { deps } = fakeDeps(failRun);
  const out = await runTest(
    makeCtx(["test", "run"], ["tests/"], { id: "a", "github-annotations": true }),
    deps,
  );
  assert.match(out.text ?? "", /::error file=tests\/t\.py,line=7::AssertionError: 1 != 2/);
});

/* ── CLI-094: flaky detector (retry + flag) ──────────────────────────────────────── */

/** A deps whose initial run fails 3 tests, and whose per-id retries produce: genuine (all fail),
 *  flaky (fail then pass), confirmed-fixed (all pass). Initial vs retry is told apart by onEvent. */
function flakyRetryDeps(opts: { onlyFlaky?: boolean } = {}) {
  const retryCounts: Record<string, number> = {};
  const deps: SidecarDeps = {
    runSidecar: (async (
      _script: string,
      argv: string[],
      o?: { onEvent?: (e: Record<string, unknown>) => void },
    ) => {
      if (argv[0] === "discover") return { ok: true, command: "discover", tree: [] };
      if (o?.onEvent) {
        // initial run — 1 pass + the failing set.
        o.onEvent({ event: "test", id: "t::ok", status: "pass" });
        o.onEvent({ event: "test", id: "t::flaky", status: "fail", file: "t.py", line: 2 });
        if (!opts.onlyFlaky) {
          o.onEvent({ event: "test", id: "t::genuine", status: "fail", file: "t.py", line: 1 });
          o.onEvent({ event: "test", id: "t::fixed", status: "fail", file: "t.py", line: 3 });
        }
        const failed = opts.onlyFlaky ? 1 : 3;
        return { ok: true, command: "run", summary: { total: 4, passed: 1, failed, skipped: 0 } };
      }
      // retry — a single --id; scripted per-id outcome.
      const id = argv[argv.indexOf("--id") + 1] ?? "";
      retryCounts[id] = (retryCounts[id] ?? 0) + 1;
      const n = retryCounts[id];
      const passed = id === "t::genuine" ? false : id === "t::flaky" ? n >= 2 : /* t::fixed */ true;
      return {
        ok: true,
        command: "run",
        summary: { total: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1, skipped: 0 },
      };
    }) as SidecarDeps["runSidecar"],
  };
  return { deps };
}

test("CLI-094 --retry-failed: genuine stays FAIL, flaky/fixed distinct bucket + history; exit 1", async () => {
  const prev = process.env.HOME;
  const tmp = mkdtempSync(pathJoin(tmpdir(), "prom-flaky-"));
  process.env.HOME = tmp; // flaky memory writes under a temp config home
  try {
    const { deps } = flakyRetryDeps();
    const out = await runTest(
      makeCtx(["test", "run"], ["tests/"], {
        id: "t::ok,t::flaky,t::genuine,t::fixed",
        "retry-failed": "3",
      }),
      deps,
    );
    assert.equal(out.exitCode, 1, "a genuine failure keeps exit non-zero");
    const text = out.text ?? "";
    assert.match(text, /FAIL \(genuine\) t::genuine\s+\[✗✗✗\]/);
    assert.match(text, /⚡ FLAKY t::flaky\s+\[✗✓✓\]/); // fail then pass — the retry history is visible
    assert.match(text, /passed every retry\) t::fixed\s+\[✓✓✓\]/);
    // persisted flaky memory: flaky + fixed accumulate, genuine does NOT.
    const store = JSON.parse(
      readFileSync(pathJoin(tmp, ".config", "prometheus-studio", "flaky-tests.json"), "utf8"),
    );
    assert.equal(store["t::flaky"]?.count, 1);
    assert.equal(store["t::fixed"]?.count, 1);
    assert.equal(store["t::genuine"], undefined);
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: restore env exactly
      delete process.env.HOME;
    } else {
      process.env.HOME = prev;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI-094 flaky memory ACCUMULATES across invocations (count bumps)", async () => {
  const prev = process.env.HOME;
  const tmp = mkdtempSync(pathJoin(tmpdir(), "prom-flaky2-"));
  process.env.HOME = tmp;
  try {
    const run = () =>
      runTest(
        makeCtx(["test", "run"], ["tests/"], { id: "t::flaky", "retry-failed": "2" }),
        flakyRetryDeps({ onlyFlaky: true }).deps,
      );
    await run();
    await run(); // second invocation of the same flaky test
    const store = JSON.parse(
      readFileSync(pathJoin(tmp, ".config", "prometheus-studio", "flaky-tests.json"), "utf8"),
    );
    assert.equal(store["t::flaky"]?.count, 2, "recurrence is visible over time");
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: restore env exactly
      delete process.env.HOME;
    } else {
      process.env.HOME = prev;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI-094 --tolerate-flaky: only-flaky failures → exit 0 (but still shown as flaky)", async () => {
  const prev = process.env.HOME;
  const tmp = mkdtempSync(pathJoin(tmpdir(), "prom-flaky3-"));
  process.env.HOME = tmp;
  try {
    const { deps } = flakyRetryDeps({ onlyFlaky: true });
    const out = await runTest(
      makeCtx(["test", "run"], ["tests/"], {
        id: "t::flaky",
        "retry-failed": "2",
        "tolerate-flaky": true,
      }),
      deps,
    );
    assert.equal(out.exitCode, 0, "flaky tolerated → exit 0");
    assert.match(out.text ?? "", /⚡ FLAKY t::flaky/); // still visible, not silently passed
    assert.match(out.text ?? "", /flaky tolerated/);
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: restore env exactly
      delete process.env.HOME;
    } else {
      process.env.HOME = prev;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
