import assert from "node:assert/strict";
/**
 * tmux/multiplexer.test.ts — when `launchTmuxSession` multiplexes, and when it stays in one
 * window (tmux compatibility mode). Every seam is a fake: nothing here spawns tmux, a pty or
 * the readline host.
 */
import test from "node:test";

import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import {
  type TmuxSessionDeps,
  buildSessionLayout,
  launchTmuxSession,
  selfInvocation,
} from "./multiplexer.js";
import type { TmuxSpec } from "./tmux.js";

setColorEnabled(false);

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

function harness(opts: {
  available: boolean;
  enabled: boolean;
  nested: boolean;
  started?: boolean;
}) {
  const specs: TmuxSpec[] = [];
  let single = 0;
  const deps: TmuxSessionDeps = {
    tmuxAvailable: () => opts.available,
    tmuxEnabled: () => opts.enabled,
    insideTmux: () => opts.nested,
    runTmux: async (spec) => {
      specs.push(spec);
      return { code: 0, started: opts.started ?? true };
    },
    self: { argv: ["prometheus"] },
    launchSession: async () => {
      single++;
      return 0;
    },
    write: () => {},
  };
  return { deps, specs, single: () => single };
}

test("no tmux installed, --tmux asked ⇒ one window, tmux never run", async () => {
  const h = harness({ available: false, enabled: true, nested: false });
  assert.equal(await launchTmuxSession(parsed({ tmux: true }), h.deps), 0);
  assert.equal(h.single(), 1);
  assert.equal(h.specs.length, 0);
});

test("already inside tmux ⇒ one window — never a nested `tmux attach`", async () => {
  // With PROMETHEUS_TMUX=1 inherited, the session's own `main` window re-entered the
  // multiplexer and attached again; tmux refuses to nest, so that window died every time.
  const h = harness({ available: true, enabled: true, nested: true });
  assert.equal(await launchTmuxSession(parsed({ tmux: true }), h.deps), 0);
  assert.equal(h.single(), 1);
  assert.equal(h.specs.length, 0);
});

test("tmux usable and asked for ⇒ multiplexed, main window runs the REPL", async () => {
  const h = harness({ available: true, enabled: true, nested: false });
  assert.equal(await launchTmuxSession(parsed({ tmux: "work" }), h.deps), 0);
  assert.equal(h.single(), 0);
  assert.equal(h.specs.length, 1);
  assert.equal(h.specs[0]?.session, "work");
  assert.deepEqual(h.specs[0]?.windows[0]?.argv, ["prometheus", "repl"]);
});

test("tmux installed but not asked for ⇒ one window", async () => {
  const h = harness({ available: true, enabled: false, nested: false });
  await launchTmuxSession(parsed(), h.deps);
  assert.equal(h.single(), 1);
  assert.equal(h.specs.length, 0);
});

test("tmux installed but unable to start the session ⇒ single window, not a dead end", async () => {
  const h = harness({ available: true, enabled: true, nested: false, started: false });
  const lines: string[] = [];
  h.deps.write = (l) => lines.push(l);
  assert.equal(await launchTmuxSession(parsed({ tmux: true }), h.deps), 0);
  assert.equal(h.specs.length, 1, "tmux was tried");
  assert.equal(h.single(), 1, "then the single window opened");
  assert.ok(
    lines.some((l) => /tmux could not start the session/.test(l)),
    lines.join("\n"),
  );
});

test("windows run THIS Prometheus — never whatever `prometheus` is on the tmux server's PATH", () => {
  const self = selfInvocation(
    {
      argv: ["/opt/node", "/src/apps/cli/dist/bin.js", "--tmux"],
      execPath: "/opt/node",
      execArgv: [],
      env: { PROMETHEUS_PY: "/src/prometheus.py", PATH: "/tc/node/bin:/usr/bin", HOME: "/h" },
    },
    () => true,
  );
  assert.deepEqual(self.argv, ["/opt/node", "/src/apps/cli/dist/bin.js"]);
  assert.deepEqual(self.env, {
    PROMETHEUS_PY: "/src/prometheus.py",
    PATH: "/tc/node/bin:/usr/bin",
  });
  const spec = buildSessionLayout(parsed({ tmux: true }), self);
  assert.deepEqual(spec.windows[0]?.argv, ["/opt/node", "/src/apps/cli/dist/bin.js", "repl"]);
  for (const w of spec.windows) {
    assert.equal(w.argv[0], "/opt/node", `${w.name} runs a bare command`);
    assert.equal(w.env?.PROMETHEUS_PY, "/src/prometheus.py");
  }
});

test("no entry script to re-run ⇒ the bare command, as before", () => {
  const self = selfInvocation(
    { argv: ["node"], execPath: "/opt/node", execArgv: [], env: {} },
    () => false,
  );
  assert.deepEqual(self, { argv: ["prometheus"] });
});
