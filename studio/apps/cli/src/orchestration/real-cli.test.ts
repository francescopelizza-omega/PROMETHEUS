/**
 * real-cli.test.ts — the FULL orchestrator mechanics over REAL subprocess CLIs.
 *
 * This is the load-bearing self-test: it spawns a MOCK agent CLI (a tiny node script that
 * mimics a real headless CLI — `cli -p "<prompt>"` → reply on stdout, exit) through the
 * SHIPPED path (recipe → hardened spawn-capture → outcome classifier), and drives a real
 * swarm: orchestrator fans out to two peers IN PARALLEL, one peer SPAWNS a child-subagent
 * (depth 2), results flow back up the bus, the orchestrator synthesizes. It also proves the
 * STANDALONE INVARIANT — the mock records every argv it receives, and we assert it was
 * invoked EXACTLY as `-p <prompt>` (the CLI's own interface), never patched by Prometheus.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { orchestration as orch } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import { makeInvoker } from "./backends.js";
import type { CliRecipe } from "./recipes.js";

// A mock agent CLI: reads `-p <prompt>`, logs its argv (standalone-invariant proof), and
// emits directives by the agent name baked into the prompt — so a REAL fan-out/spawn happens.
const MOCK_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const pi = argv.indexOf("-p");
const prompt = pi >= 0 ? (argv[pi + 1] || "") : "";
if (process.env.MOCK_ARGV_LOG) { try { fs.appendFileSync(process.env.MOCK_ARGV_LOG, JSON.stringify(argv) + "\\n"); } catch {} }
const m = prompt.match(/You are "([^"]+)"/);
const name = m ? m[1] : "?";
const hasInbox = prompt.includes("Messages for you:");
function reply() {
  if (hasInbox) return "[" + name + "] integrated results from my children.";
  if (name === "lead") return "Plan:\\n@api: build the API\\n@ui: build the UI";
  if (name === "api") return "@spawn dbtest=cli:mockcli: write a db test\\nAPI scaffold built.";
  if (name === "ui") return "UI built.";
  if (name === "dbtest") return "DB test written.";
  return name + " handled the task.";
}
process.stdout.write(reply());
`;

const fakeEngine = (): EngineClient =>
  ({ runPrometheus: async () => ({ ok: true }) }) as unknown as EngineClient;

test("FULL mechanics over real subprocess CLIs: fan-out + spawn + hierarchy + synthesis", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-realcli-"));
  const mockPath = join(dir, "mockcli");
  const argvLog = join(dir, "argv.log");
  writeFileSync(mockPath, MOCK_CLI);
  chmodSync(mockPath, 0o755);
  const prevLog = process.env.MOCK_ARGV_LOG;
  process.env.MOCK_ARGV_LOG = argvLog;

  try {
    // a recipe override pointing the "mockcli" service at our mock binary — the EXACT
    // shipped launch shape: `<bin> -p <prompt>`, prompt as a discrete argv element.
    const recipes: Record<string, CliRecipe> = {
      mockcli: {
        service: "mockcli",
        bin: mockPath,
        buildArgs: (p) => ["-p", p],
        promptVia: "arg",
        timeoutMs: 20_000,
        note: "mock",
      },
    };

    const topology = orch.normalizeTopology({
      orchestrator: "lead",
      agents: [
        {
          name: "lead",
          backend: { kind: "cli", service: "mockcli" },
          role: "orchestrate",
          children: ["api", "ui"],
        },
        { name: "api", backend: { kind: "cli", service: "mockcli" }, role: "backend" },
        { name: "ui", backend: { kind: "cli", service: "mockcli" }, role: "frontend" },
      ],
    });

    // the REAL invoker: real spawn-capture, real PATH check on the abs path, recipe override.
    const invoke = makeInvoker({ client: fakeEngine(), recipes });
    const events: orch.RunEvent[] = [];
    const result = await new orch.Coordinator({
      topology,
      invoke,
      onEvent: (e) => events.push(e),
    }).run("ship a small feature");

    // 1. the orchestrator synthesized a final answer from its children
    assert.match(result.answer, /integrated results/);

    // 2. fan-out: lead dispatched to BOTH api and ui (real parallel subprocesses)
    const dispatched = events.filter((e) => e.type === "dispatch").map((e) => e.to);
    assert.ok(dispatched.includes("api") && dispatched.includes("ui"));

    // 3. spawn: api created a child-subagent dbtest bound to the cli backend
    assert.ok(
      events.some((e) => e.type === "spawn" && e.child === "dbtest" && e.backend === "cli:mockcli"),
    );
    assert.ok(result.agents.some((a) => a.name === "dbtest" && a.backend.kind === "cli"));

    // 4. hierarchy: dbtest (depth 2) actually ran + reported back
    const msgs = result.bus.all();
    assert.ok(
      msgs.some(
        (mm) => mm.from === "dbtest" && mm.kind === "result" && /DB test written/.test(mm.content),
      ),
    );
    // results flowed back up: api → lead and ui → lead
    assert.ok(msgs.some((mm) => mm.from === "api" && mm.to === "lead" && mm.kind === "result"));
    assert.ok(msgs.some((mm) => mm.from === "ui" && mm.to === "lead" && mm.kind === "result"));

    // 5. STANDALONE INVARIANT: every invocation was EXACTLY `-p <prompt>` — the CLI's own
    //    interface, nothing injected, nothing patched.
    const lines = readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 6, `expected ≥6 real CLI invocations, got ${lines.length}`);
    for (const line of lines) {
      const a = JSON.parse(line) as string[];
      assert.equal(a[0], "-p", `first arg is -p: ${line}`);
      assert.equal(a.length, 2, `exactly [-p, <prompt>] — no extra/patched args: ${line}`);
      assert.equal(typeof a[1], "string");
    }
  } finally {
    if (prevLog === undefined) process.env.MOCK_ARGV_LOG = undefined;
    else process.env.MOCK_ARGV_LOG = prevLog;
    rmSync(dir, { recursive: true, force: true });
  }
});
