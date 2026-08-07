/**
 * tmux/tmux.test.ts — the P6 tmux command builder + runner (node:test, source import).
 *
 * Deterministic + spawn-free: the binary lookup, the tmux runner, and the attach
 * are injected as fakes, so NOTHING ever shells out to a real tmux. We assert:
 *   - shlexQuote / shlexJoin mirror Python's shlex (injection-safe quoting),
 *   - buildTmuxCommands emits the EXACT command arrays for a multi-window spec,
 *     with the has-session idempotent guard FIRST and every token discrete,
 *   - the gates (tmuxAvailable / tmuxEnabled / tmuxSessionName) read intent vs.
 *     availability correctly,
 *   - runTmux is crash-free: missing binary / new session / existing session /
 *     spawn failure / thrown runner each return a code AND restore the tty.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import {
  type TmuxDeps,
  type TmuxSpec,
  buildTmuxCommands,
  runTmux,
  shlexJoin,
  shlexQuote,
  tmuxAvailable,
  tmuxEnabled,
  tmuxSessionName,
  windowCommand,
} from "./tmux.js";

// Color off → assertions match on plain text (no ANSI escapes to strip).
setColorEnabled(false);

/** A minimal ParsedArgs with only the fields the gates read. */
function parsed(flags: Record<string, string | true> = {}): ParsedArgs {
  return {
    command: [],
    positionals: [],
    json: false,
    noColor: false,
    help: false,
    version: false,
    repl: false,
    dryRun: false,
    yes: false,
    strict: false,
    force: false,
    noGate: false,
    verbose: false,
    quiet: false,
    flags,
  };
}

// ── shlex quoting (the injection-safety primitive) ───────────────────────── //

test("shlexQuote: safe tokens pass through, unsafe tokens single-quote", () => {
  assert.equal(shlexQuote("claude"), "claude");
  assert.equal(shlexQuote("--model"), "--model");
  assert.equal(shlexQuote("/usr/bin/claude"), "/usr/bin/claude");
  assert.equal(shlexQuote(""), "''");
  assert.equal(shlexQuote("with space"), "'with space'");
  // a shell-metachar payload is contained inside single quotes — no breakout.
  assert.equal(shlexQuote("$(rm -rf /)"), "'$(rm -rf /)'");
  assert.equal(shlexQuote("a;b|c&d"), "'a;b|c&d'");
});

test("shlexQuote: embedded single quote escapes as '\"'\"'", () => {
  assert.equal(shlexQuote("it's"), `'it'"'"'s'`);
});

test("shlexJoin joins an argv into one shell-safe string", () => {
  assert.equal(shlexJoin(["claude", "--model", "opus"]), "claude --model opus");
  assert.equal(shlexJoin(["prometheus", "chat", "hello world"]), "prometheus chat 'hello world'");
});

test("windowCommand prefixes shlex-quoted env then the joined argv", () => {
  assert.equal(
    windowCommand({
      name: "chat",
      argv: ["claude", "--cwd", "/proj space"],
      env: { GEMINI_SYSTEM_MD: "/sys path.md", FLAG: "1" },
    }),
    "GEMINI_SYSTEM_MD='/sys path.md' FLAG=1 claude --cwd '/proj space'",
  );
});

// ── pure builder: EXACT command arrays ───────────────────────────────────── //

test("buildTmuxCommands: multi-window spec → exact, injection-safe arrays", () => {
  const spec: TmuxSpec = {
    session: "prometheus",
    windows: [
      { name: "main", argv: ["prometheus", "repl"], cwd: "/work" },
      {
        name: "chat",
        argv: ["claude", "--cwd", "/proj space"],
        env: { GEMINI_SYSTEM_MD: "/s p.md" },
      },
      { name: "health", argv: ["prometheus", "doctor"] },
    ],
  };

  const cmds = buildTmuxCommands(spec);

  assert.deepEqual(cmds, [
    // 1) idempotent guard FIRST
    ["has-session", "-t", "prometheus"],
    // 2) main window (detached new-session, with cwd + shlex-joined command)
    ["new-session", "-d", "-s", "prometheus", "-n", "main", "-c", "/work", "prometheus repl"],
    // 3) extra windows (env prefix shlex-quoted; spaced path quoted)
    [
      "new-window",
      "-t",
      "prometheus",
      "-n",
      "chat",
      "GEMINI_SYSTEM_MD='/s p.md' claude --cwd '/proj space'",
    ],
    ["new-window", "-t", "prometheus", "-n", "health", "prometheus doctor"],
    // 4) default layout for >1 window
    ["select-layout", "-t", "prometheus", "tiled"],
    // 5) focus the main window
    ["select-window", "-t", "prometheus:main"],
  ]);
});

test("buildTmuxCommands: single window → no layout, guard + create + focus", () => {
  const cmds = buildTmuxCommands({
    session: "solo",
    windows: [{ name: "main", argv: ["prometheus", "repl"] }],
  });
  assert.deepEqual(cmds, [
    ["has-session", "-t", "solo"],
    ["new-session", "-d", "-s", "solo", "-n", "main", "prometheus repl"],
    ["select-window", "-t", "solo:main"],
  ]);
});

test("buildTmuxCommands: explicit layout:null leaves layout unset", () => {
  const cmds = buildTmuxCommands({
    session: "s",
    windows: [
      { name: "main", argv: ["a"] },
      { name: "b", argv: ["b"] },
    ],
    layout: null,
  });
  assert.ok(!cmds.some((cmd) => cmd[0] === "select-layout"));
});

test("buildTmuxCommands: empty windows → guard only (no create)", () => {
  const cmds = buildTmuxCommands({ session: "s", windows: [] });
  assert.deepEqual(cmds, [["has-session", "-t", "s"]]);
});

// ── gates ────────────────────────────────────────────────────────────────── //

test("tmuxAvailable uses the injected lookup", () => {
  assert.equal(tmuxAvailable({ lookupBin: () => "/usr/bin/tmux" }), true);
  assert.equal(tmuxAvailable({ lookupBin: () => null }), false);
});

test("tmuxAvailable never throws when the lookup throws", () => {
  assert.equal(
    tmuxAvailable({
      lookupBin: () => {
        throw new Error("boom");
      },
    }),
    false,
  );
});

test("tmuxEnabled: --tmux flag (bare or with NAME) opts in", () => {
  assert.equal(tmuxEnabled(parsed({ tmux: true }), { env: {} }), true);
  assert.equal(tmuxEnabled(parsed({ tmux: "work" }), { env: {} }), true);
});

test("tmuxEnabled: PROMETHEUS_TMUX=1 opts in", () => {
  assert.equal(tmuxEnabled(parsed(), { env: { PROMETHEUS_TMUX: "1" } }), true);
  assert.equal(tmuxEnabled(parsed(), { env: { PROMETHEUS_TMUX: "0" } }), false);
});

test("tmuxEnabled: settingTmux opts in; otherwise off", () => {
  assert.equal(tmuxEnabled(parsed(), { env: {}, settingTmux: true }), true);
  assert.equal(tmuxEnabled(parsed(), { env: {} }), false);
});

test("tmuxSessionName: --tmux NAME wins, bare --tmux → fallback", () => {
  assert.equal(tmuxSessionName(parsed({ tmux: "ci" })), "ci");
  assert.equal(tmuxSessionName(parsed({ tmux: true })), "prometheus");
  assert.equal(tmuxSessionName(parsed({ tmux: true }), "fallback"), "fallback");
});

// ── runner (crash-free, fully faked) ─────────────────────────────────────── //

/** A fake TmuxDeps that records every tmux invocation + attach + tty restore. */
function fakeDeps(opts: {
  available?: boolean;
  /** status per non-attach command, keyed by its first token; default 0. */
  status?: (argv: string[]) => number;
  attachStatus?: number;
  throwOnRun?: boolean;
}): {
  deps: TmuxDeps;
  runs: string[][];
  attaches: string[];
  /** mutable counter object so the closure increment is visible to the caller. */
  restored: { count: number };
  writes: string[];
} {
  const runs: string[][] = [];
  const attaches: string[] = [];
  const writes: string[] = [];
  const restored = { count: 0 };
  const deps: TmuxDeps = {
    lookupBin: () => (opts.available === false ? null : "/usr/bin/tmux"),
    run: (argv) => {
      if (opts.throwOnRun) throw new Error("spawn exploded");
      runs.push(argv);
      return { status: opts.status ? opts.status(argv) : 0, stderr: "scripted err" };
    },
    attach: (session) => {
      attaches.push(session);
      return { status: opts.attachStatus ?? 0 };
    },
    restoreTty: () => {
      restored.count++;
    },
    write: (line) => writes.push(line),
  };
  return { deps, runs, attaches, restored, writes };
}

const SPEC: TmuxSpec = {
  session: "prometheus",
  windows: [
    { name: "main", argv: ["prometheus", "repl"] },
    { name: "chat", argv: ["claude"] },
  ],
};

test("runTmux: missing binary → friendly line, code 2, tty restored", async () => {
  const f = fakeDeps({ available: false });
  const code = await runTmux(SPEC, f.deps);
  assert.equal(code, 2);
  assert.equal(f.restored.count, 1);
  assert.equal(f.runs.length, 0);
  assert.equal(f.attaches.length, 0);
  assert.match(f.writes.join("\n"), /tmux not found/);
});

test("runTmux: new session → runs create steps then attaches", async () => {
  // has-session returns nonzero (does not exist) → create.
  const f = fakeDeps({
    status: (argv) => (argv[0] === "has-session" ? 1 : 0),
  });
  const code = await runTmux(SPEC, f.deps);
  assert.equal(code, 0);
  // guard + new-session + new-window + select-layout + select-window all ran.
  assert.equal(f.runs[0]?.[0], "has-session");
  assert.ok(f.runs.some((r) => r[0] === "new-session"));
  assert.ok(f.runs.some((r) => r[0] === "new-window"));
  assert.deepEqual(f.attaches, ["prometheus"]);
  assert.equal(f.restored.count, 1);
  assert.match(f.writes.join("\n"), /started \(detached\)/);
});

test("runTmux: existing session → SKIPS create, attaches only (idempotent)", async () => {
  // has-session returns 0 (exists) → no create steps run.
  const f = fakeDeps({ status: () => 0 });
  const code = await runTmux(SPEC, f.deps);
  assert.equal(code, 0);
  assert.deepEqual(f.runs, [["has-session", "-t", "prometheus"]]);
  assert.deepEqual(f.attaches, ["prometheus"]);
  assert.match(f.writes.join("\n"), /already exists — attaching/);
  assert.equal(f.restored.count, 1);
});

test("runTmux: a create step failing → nonzero code, no attach, tty restored", async () => {
  const f = fakeDeps({
    status: (argv) => {
      if (argv[0] === "has-session") return 1; // create path
      if (argv[0] === "new-window") return 3; // fail mid-create
      return 0;
    },
  });
  const code = await runTmux(SPEC, f.deps);
  assert.equal(code, 3);
  assert.equal(f.attaches.length, 0);
  assert.equal(f.restored.count, 1);
  assert.match(f.writes.join("\n"), /new-window failed: scripted err/);
});

test("runTmux: attach exit code is propagated", async () => {
  const f = fakeDeps({
    status: (argv) => (argv[0] === "has-session" ? 1 : 0),
    attachStatus: 130,
  });
  const code = await runTmux(SPEC, f.deps);
  assert.equal(code, 130);
  assert.equal(f.restored.count, 1);
});

test("runTmux: a thrown runner is caught → code 1, friendly line, tty restored", async () => {
  const f = fakeDeps({ throwOnRun: true });
  const code = await runTmux(SPEC, f.deps);
  assert.equal(code, 1);
  assert.equal(f.restored.count, 1);
  assert.match(f.writes.join("\n"), /tmux launch failed: spawn exploded/);
});

test("runTmux: a throwing restoreTty never escapes (exit path stays crash-free)", async () => {
  const code = await runTmux(SPEC, {
    lookupBin: () => null,
    write: () => {},
    restoreTty: () => {
      throw new Error("restore boom");
    },
  });
  assert.equal(code, 2); // missing-binary path, but restore throw is swallowed.
});
