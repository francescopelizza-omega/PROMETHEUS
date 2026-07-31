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

import { type DemosTmuxDeps, interactiveCommand, runDemosTmux } from "./demos-tmux.js";
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
