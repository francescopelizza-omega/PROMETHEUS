/**
 * demos-tmux.test.ts — the tmux-mandatory /demos wiring (fake tmux run + fake scheduler):
 * tmux gating, the ToS auth gate, interactive launch argv, preamble injection.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { orchestration as orch } from "@prometheus/core";

import {
  type DemosTmuxDeps,
  interactiveCommand,
  interactiveEnv,
  runDemosTmux,
} from "./demos-tmux.js";
import type { TmuxRun } from "./tmux-driver.js";

const TOP = orch.normalizeTopology({
  orchestrator: "lead",
  agents: [
    {
      name: "lead",
      backend: { kind: "cli", service: "claude" },
      role: "orchestrate",
      children: ["api"],
    },
    { name: "api", backend: { kind: "cli", service: "codex" }, role: "backend" },
  ],
});

function harness(over: Partial<DemosTmuxDeps> = {}) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "demos-tmux-"));
  const run: TmuxRun = (argv) => {
    calls.push(argv);
    return { status: 0, stdout: "%1", stderr: "" };
  };
  const deps: DemosTmuxDeps = {
    topology: TOP,
    goal: "build a feature",
    home,
    write: (l) => lines.push(l),
    confirm: async () => true,
    env: { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", PATH: "/usr/bin" }, // api-key → no gate
    run,
    sleep: async () => {},
    bootMs: 0,
    runRelayFn: async () => ({ reason: "complete", ticks: 3, delivered: 4 }),
    runId: "test01",
    ...over,
  };
  return { deps, calls, lines, home };
}

test("interactiveCommand: cli → bare bin; local → ollama run", () => {
  assert.deepEqual(
    interactiveCommand({ name: "a", role: "r", backend: { kind: "cli", service: "claude" } }),
    ["claude"],
  );
  assert.deepEqual(
    interactiveCommand({ name: "a", role: "r", backend: { kind: "local", model: "qwen" } }),
    ["ollama", "run", "qwen"],
  );
  assert.equal(interactiveCommand({ name: "a", role: "r", backend: { kind: "fake" } }), null);
});

test("refuses when tmux is absent", async () => {
  const h = harness({ run: () => ({ status: 1, stdout: "", stderr: "" }) });
  try {
    const r = await runDemosTmux(h.deps);
    assert.equal(r.reason, "no-tmux");
    assert.match(h.lines.join("\n"), /needs tmux/);
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("ToS auth gate: a subscription claude → warn + confirm; decline aborts", async () => {
  const h = harness({ env: { PATH: "/usr/bin" }, confirm: async () => false }); // no API key → subscription
  try {
    const r = await runDemosTmux(h.deps);
    assert.equal(r.reason, "declined");
    assert.match(h.lines.join("\n"), /Anthropic Consumer Terms|automated/i);
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("happy path: launches a window per agent + injects the preamble + runs the relay", async () => {
  const h = harness();
  try {
    const r = await runDemosTmux(h.deps);
    assert.equal(r.ok, true);
    assert.equal(r.reason, "complete");
    // a new-session for the orchestrator, a new-window for the subagent
    assert.ok(
      h.calls.some((c) => c[0] === "new-session" && c.includes("lead") && c.includes("claude")),
    );
    assert.ok(
      h.calls.some((c) => c[0] === "new-window" && c.includes("api") && c.includes("codex")),
    );
    // env injected per window
    assert.ok(h.calls.some((c) => c.some((a) => a.startsWith("PROM_AGENT=lead"))));
    assert.ok(h.calls.some((c) => c.some((a) => a.startsWith("PROM_BUS_SOCK="))));
    // the preamble was typed into the orchestrator window (send-keys -l with ORCHESTRATOR text)
    const sends = h.calls.filter((c) => c[0] === "send-keys" && c.includes("-l"));
    assert.ok(sends.some((c) => (c.at(-1) ?? "").includes("ORCHESTRATOR")));
    assert.ok(sends.some((c) => (c.at(-1) ?? "").includes("build a feature"))); // goal injected
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("tmux older than 3.2 (no per-window -e) ⇒ old-tmux, nothing launched", async () => {
  // RHEL 8 ships 2.7, Debian 10 2.8, Ubuntu 20.04 3.0a — all reject `new-session -e`.
  const calls: string[][] = [];
  const h = harness({
    run: (argv) => {
      calls.push(argv);
      return { status: 0, stdout: argv[0] === "-V" ? "tmux 3.0a" : "", stderr: "" };
    },
  });
  try {
    const r = await runDemosTmux(h.deps);
    assert.equal(r.reason, "old-tmux");
    assert.deepEqual(calls, [["-V"]], "nothing past the version probe ran");
    assert.match(h.lines.join("\n"), /needs tmux 3\.2\+ .*tmux 3\.0a/);
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("a window tmux refuses ⇒ launch-failed, the half-built session is killed, no false 'launched'", async () => {
  const calls: string[][] = [];
  const h = harness({
    run: (argv) => {
      calls.push(argv);
      if (argv[0] === "-V") return { status: 0, stdout: "tmux 3.4", stderr: "" };
      if (argv[0] === "new-window") return { status: 1, stdout: "", stderr: "unknown flag -e" };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  try {
    const r = await runDemosTmux(h.deps);
    assert.equal(r.reason, "launch-failed");
    const said = h.lines.join("\n");
    assert.doesNotMatch(said, /swarm launched/);
    assert.match(said, /new-window for api failed: unknown flag -e/);
    const kills = calls.filter((c) => c[0] === "kill-session");
    assert.equal(kills.length, 2, "the stale-session clear, then the half-built one");
  } finally {
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("3.2 and newer, or an unparseable version, go ahead", async () => {
  for (const v of ["tmux 3.2", "tmux 3.5a", "tmux next-3.6", "tmux master"]) {
    const h = harness({
      run: (argv) => ({ status: 0, stdout: argv[0] === "-V" ? v : "%1", stderr: "" }),
    });
    try {
      const r = await runDemosTmux(h.deps);
      assert.equal(r.reason, "complete", v);
    } finally {
      rmSync(h.home, { recursive: true, force: true });
    }
  }
});

test("interactiveCommand: no invented model (`ollama run llama3` downloads GBs); LM Studio gets `lms chat`; local CLIs get their wiring", () => {
  const LMS = {
    id: "l",
    baseUrl: "http://localhost:1234/v1",
    locality: "local" as const,
    contextWindow: 8192,
    model: "google/gemma-3-12b",
  };
  assert.equal(interactiveCommand({ name: "l", role: "r", backend: { kind: "local" } }), null);
  const lms = interactiveCommand({ name: "l", role: "r", backend: { kind: "local" } }, LMS);
  assert.deepEqual(lms?.slice(-2), ["chat", "google/gemma-3-12b"]);
  assert.deepEqual(
    interactiveCommand(
      { name: "o", role: "r", backend: { kind: "cli", service: "opencode", local: true } },
      LMS,
    ),
    ["opencode", "-m", "prometheus-local/google/gemma-3-12b"],
  );
  const env = interactiveEnv(
    { name: "o", role: "r", backend: { kind: "cli", service: "opencode", local: true } },
    LMS,
  );
  assert.equal(env[0], "-e");
  assert.match(
    env[1] ?? "",
    /^OPENCODE_CONFIG_CONTENT=\{.*"baseURL":"http:\/\/localhost:1234\/v1"/,
  );
  assert.equal(
    interactiveCommand(
      { name: "c", role: "r", backend: { kind: "cli", service: "claude", local: true } },
      LMS,
    ),
    null,
    "no local mode ⇒ no window, never the cloud login",
  );
});
