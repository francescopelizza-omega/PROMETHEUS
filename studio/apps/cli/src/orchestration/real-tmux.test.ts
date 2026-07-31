/**
 * real-tmux.test.ts — THE proof: interactive "agents" in REAL tmux windows cooperate via
 * the EXTERNAL relay. Fake agents (node REPLs that read stdin + emit via the real prom-msg
 * helper over the unix socket) run in real tmux windows; the relay holds the bus IN RAM and
 * delivers peer messages back into the windows with send-keys, idle-gated. We assert the
 * full conversation flowed: lead → api+ui (fan-out) → api/ui → lead (report) → lead `done`.
 * Skips when tmux is absent. No vendor CLI, no model, no cost — pure machinery.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { orchestration as orch } from "@prometheus/core";

import { startBusRelay } from "./bus-relay.js";
import { installPromMsg } from "./prom-msg.js";
import { type TmuxRun, injectLine, makeTmuxRelay, makeTmuxRun } from "./tmux-driver.js";

const FAKE_AGENT = `"use strict";
// fake interactive agent: read stdin lines, react by running prom-msg over the socket.
const readline = require("node:readline");
const { execFileSync } = require("node:child_process");
const name = process.argv[2];
const MSG = process.env.PROM_MSG_BIN;
function send(to, text) { try { execFileSync(process.execPath, [MSG, to, text], { stdio: "ignore", timeout: 6000 }); } catch (e) {} }
const got = new Set();
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write("ready\\n> ");
rl.on("line", (line) => {
  process.stdout.write("\\nworking...\\n");
  if (name === "lead") {
    if (/GOAL:/.test(line)) { send("api", "do part A"); send("ui", "do part B"); }
    else { const m = line.match(/\\[from (\\w+)\\]/); if (m) got.add(m[1]); if (got.has("api") && got.has("ui")) send("done", "integrated A+B"); }
  } else {
    if (/\\[from /.test(line)) send("lead", name + " finished its part");
  }
  process.stdout.write("\\n> ");
});
`;

const tmuxOk = (): boolean => {
  try {
    return makeTmuxRun()(["-V"]).status === 0;
  } catch {
    return false;
  }
};

test(
  "REAL tmux: a 3-agent swarm cooperates entirely through the external RAM relay",
  { skip: !tmuxOk() },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "promtmux-"));
    const fakeAgent = join(dir, "fa.cjs");
    writeFileSync(fakeAgent, FAKE_AGENT);
    const bin = installPromMsg(join(dir, "bin"));
    const sock = `/tmp/pmt-${process.pid}.sock`;
    const session = `promtest-${process.pid}`;
    const run: TmuxRun = makeTmuxRun();

    const topology = orch.normalizeTopology({
      orchestrator: "lead",
      agents: [
        { name: "lead", backend: { kind: "fake" }, role: "o", children: ["api", "ui"] },
        { name: "api", backend: { kind: "fake" }, role: "b" },
        { name: "ui", backend: { kind: "fake" }, role: "f" },
      ],
    });
    const bus = new orch.MessageBus({ now: () => 0 });
    const relay = startBusRelay({
      bus,
      sockPath: sock,
      resolve: { orchestrator: "lead", parentOf: (n) => (n === "lead" ? undefined : "lead") },
    });

    const launchWin = (first: boolean, agent: string): void => {
      const env = [
        "-e",
        `PROM_BUS_SOCK=${sock}`,
        "-e",
        `PROM_AGENT=${agent}`,
        "-e",
        `PROM_MSG_BIN=${bin}`,
      ];
      const cmd = [process.execPath, fakeAgent, agent];
      if (first) run(["new-session", "-d", "-s", session, "-n", agent, ...env, ...cmd]);
      else run(["new-window", "-t", session, "-n", agent, ...env, ...cmd]);
    };

    try {
      run(["kill-session", "-t", session]); // clean any stale
      launchWin(true, "lead");
      launchWin(false, "api");
      launchWin(false, "ui");
      await new Promise((r) => setTimeout(r, 1500)); // let the node REPLs come up + print the prompt

      // kick the orchestrator off (Prometheus injects the goal at start)
      injectLine(run, session, "lead", "GOAL: build the feature");

      const tmux = makeTmuxRelay({
        session,
        agents: ["lead", "api", "ui"],
        serviceOf: () => "generic",
        run,
      });
      const r = await orch.runRelay({
        bus,
        topology,
        tmux,
        clock: { now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)) },
        config: {
          tickMs: 200,
          settleTicks: 2,
          quiesceTicks: 8,
          deadlockTicks: 60,
          maxRunMs: 25000,
        },
      });

      const msgs = bus.all();
      // lead fanned out to BOTH children
      assert.ok(
        msgs.some((m) => m.from === "lead" && m.to === "api"),
        "lead → api",
      );
      assert.ok(
        msgs.some((m) => m.from === "lead" && m.to === "ui"),
        "lead → ui",
      );
      // both children reported back to lead
      assert.ok(
        msgs.some((m) => m.from === "api" && m.to === "lead"),
        "api → lead",
      );
      assert.ok(
        msgs.some((m) => m.from === "ui" && m.to === "lead"),
        "ui → lead",
      );
      // lead integrated + finished (the `done` sentinel → result to user)
      assert.ok(
        msgs.some((m) => m.from === "lead" && m.to === "user" && m.kind === "result"),
        "lead done",
      );
      assert.equal(r.reason, "complete");
    } finally {
      run(["kill-session", "-t", session]);
      relay.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
