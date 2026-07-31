/**
 * agents.test.ts — sandbox guards + ToolBroker + orchestrator loop + runtime spawn.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ToolAnnotations } from "../mcp/server/index.js";
import { type ModelClient, type ModelTurn, type RunMessage, runAgent } from "./orchestrator.js";
import { AgentRuntime, buildDispatcher } from "./runtime.js";
import {
  expandWorkspace,
  globMatch,
  isPathAllowed,
  narrowSandbox,
  normalizePath,
  parseToolRef,
  sandboxWithin,
} from "./sandbox.js";
import { brokerDecision } from "./toolBroker.js";
import { type AgentDef, type AgentSandbox, DEFAULT_SANDBOX } from "./types.js";

const RO: ToolAnnotations = { readOnlyHint: true };
const DESTRUCTIVE: ToolAnnotations = { destructiveHint: true };

function agent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "a1",
    name: "Agent One",
    description: "test agent",
    model: { provider: "local", modelId: "qwen3:8b" },
    system: "you are a test agent",
    tools: [],
    sandbox: DEFAULT_SANDBOX,
    source: "user",
    ...over,
  };
}

test("parseToolRef: engine / ext / mcp forms", () => {
  assert.deepEqual(parseToolRef("engine:install"), {
    kind: "engine",
    tool: "install",
    raw: "engine:install",
  });
  assert.deepEqual(parseToolRef("ext:acme.csv:open"), {
    kind: "ext",
    extId: "acme.csv",
    tool: "open",
    raw: "ext:acme.csv:open",
  });
  assert.deepEqual(parseToolRef("github:search"), {
    kind: "mcp",
    serverId: "github",
    tool: "search",
    raw: "github:search",
  });
  assert.equal(parseToolRef("nocolon"), null);
});

test("path guard: normalize, glob, allowlist with ${workspace}; reject escapes", () => {
  assert.equal(normalizePath("/w/./a//b/../c"), "/w/a/c");
  assert.equal(normalizePath("a/../../b"), "../b");
  assert.equal(expandWorkspace("${workspace}/src/**", "/w"), "/w/src/**");
  assert.equal(globMatch("/w/**", "/w/src/main.ts"), true);
  assert.equal(globMatch("/w/*.ts", "/w/a.ts"), true);
  assert.equal(globMatch("/w/*.ts", "/w/sub/a.ts"), false);
  assert.equal(isPathAllowed("/w/src/a.ts", ["${workspace}/**"], "/w"), true);
  assert.equal(isPathAllowed("/etc/passwd", ["${workspace}/**"], "/w"), false);
  assert.equal(isPathAllowed("../../etc", ["${workspace}/**"], "/w"), false);
});

test("sandbox narrowing: child ⊆ parent; intersect never broadens", () => {
  const parent: AgentSandbox = {
    fsRead: ["${workspace}/**", "/tmp/**"],
    fsWrite: ["${workspace}/out/**"],
    network: "mcp-only",
    shell: false,
    timeoutSec: 600,
  };
  const okChild: AgentSandbox = {
    fsRead: ["${workspace}/**"],
    fsWrite: [],
    network: "none",
    shell: false,
    timeoutSec: 300,
  };
  const broadNet: AgentSandbox = { ...okChild, network: "allow" };
  const broadShell: AgentSandbox = { ...okChild, shell: true };
  const broadRead: AgentSandbox = { ...okChild, fsRead: ["/etc/**"] };
  assert.equal(sandboxWithin(okChild, parent), true);
  assert.equal(sandboxWithin(broadNet, parent), false);
  assert.equal(sandboxWithin(broadShell, parent), false);
  assert.equal(sandboxWithin(broadRead, parent), false);

  const narrowed = narrowSandbox(parent, broadRead);
  assert.deepEqual(narrowed.fsRead, []); // /etc/** not in parent → dropped
  assert.equal(narrowed.network, "none"); // broadRead.network was "none"
  assert.equal(sandboxWithin(narrowed, parent), true);
});

test("broker: allowlist + maxCalls + read-only auto + destructive confirm", () => {
  // not in allowlist → block
  assert.equal(brokerDecision({ ref: "engine:install", grant: undefined }).action, "block");
  // read-only + autoApprove → auto
  assert.equal(
    brokerDecision({ ref: "p:read", annotations: RO, grant: { ref: "p:read", autoApprove: true } })
      .action,
    "auto",
  );
  // read-only without autoApprove → confirm
  assert.equal(
    brokerDecision({ ref: "p:read", annotations: RO, grant: { ref: "p:read", autoApprove: false } })
      .action,
    "confirm",
  );
  // destructive with autoApprove → STILL confirm (never auto)
  assert.equal(
    brokerDecision({
      ref: "p:rm",
      annotations: DESTRUCTIVE,
      grant: { ref: "p:rm", autoApprove: true },
    }).action,
    "confirm",
  );
  // maxCallsPerRun exceeded → block
  assert.equal(
    brokerDecision({
      ref: "p:read",
      annotations: RO,
      grant: { ref: "p:read", autoApprove: true, maxCallsPerRun: 2 },
      callsSoFar: 2,
    }).action,
    "block",
  );
});

/** A model that replays a scripted sequence of turns. */
function scriptedModel(turns: ModelTurn[]): ModelClient {
  let i = 0;
  return {
    next: async (_m: RunMessage[]) => turns[i++] ?? { kind: "final", text: "(out of script)" },
  };
}

test("orchestrator: auto-dispatches read-only, confirms destructive, blocks un-granted", async () => {
  const dispatched: string[] = [];
  const a = agent({
    tools: [
      { ref: "p:read", autoApprove: true },
      { ref: "p:rm", autoApprove: true }, // grant present but destructive → still confirm
    ],
  });
  const annotations: Record<string, ToolAnnotations> = { "p:read": RO, "p:rm": DESTRUCTIVE };
  const turns: ModelTurn[] = [
    { kind: "tool_call", call: { ref: "p:read", args: { x: 1 } } }, // auto
    { kind: "tool_call", call: { ref: "p:rm", args: {} } }, // confirm (denied below)
    { kind: "tool_call", call: { ref: "p:secret", args: {} } }, // not granted → block
    { kind: "final", text: "done" },
  ];
  const res = await runAgent(a, "do it", {
    model: scriptedModel(turns),
    dispatch: async (call) => {
      dispatched.push(call.ref);
      return { ok: true };
    },
    annotationsFor: (ref) => annotations[ref],
    confirm: () => false, // deny the destructive one
  });
  assert.equal(res.status, "done");
  assert.deepEqual(dispatched, ["p:read"]); // only the auto read-only ran
  assert.equal(res.steps.find((s) => s.ref === "p:rm")?.action, "denied");
  assert.equal(res.steps.find((s) => s.ref === "p:secret")?.action, "block");
});

test("orchestrator: confirmed destructive dispatches; max-steps terminates", async () => {
  const dispatched: string[] = [];
  const a = agent({ tools: [{ ref: "p:rm", autoApprove: false }] });
  const res = await runAgent(a, "rm", {
    model: scriptedModel([
      { kind: "tool_call", call: { ref: "p:rm", args: {} } },
      { kind: "final", text: "ok" },
    ]),
    dispatch: async (c) => {
      dispatched.push(c.ref);
      return { removed: true };
    },
    annotationsFor: () => DESTRUCTIVE,
    confirm: () => true,
  });
  assert.equal(res.status, "done");
  assert.deepEqual(dispatched, ["p:rm"]);

  // a model that never finalizes → max-steps (no infinite loop)
  const res2 = await runAgent(agent({ tools: [{ ref: "p:read", autoApprove: true }] }), "loop", {
    model: { next: async () => ({ kind: "tool_call", call: { ref: "p:read", args: {} } }) },
    dispatch: async () => ({ ok: true }),
    annotationsFor: () => RO,
    maxSteps: 3,
  });
  assert.equal(res2.status, "max-steps");
  assert.equal(res2.steps.length, 3);
});

test("runtime: dispatcher routing + spawn cycle/broader rejection", async () => {
  const calls: string[] = [];
  const dispatch = buildDispatcher({
    mcp: async (s, t) => {
      calls.push(`mcp:${s}:${t}`);
      return 1;
    },
    engine: async (cmd) => {
      calls.push(`engine:${cmd}`);
      return 2;
    },
  });
  await dispatch({ ref: "github:search", args: {} });
  await dispatch({ ref: "engine:list", args: {} });
  assert.deepEqual(calls, ["mcp:github:search", "engine:list"]);
  await assert.rejects(() => dispatch({ ref: "ext:a:b", args: {} }), /no extension dispatcher/);

  const rt = new AgentRuntime();
  const parent = agent({ id: "coord", sandbox: DEFAULT_SANDBOX });
  const child = agent({ id: "worker", sandbox: { ...DEFAULT_SANDBOX, network: "none" } });
  const broad = agent({ id: "broad", sandbox: { ...DEFAULT_SANDBOX, shell: true } });
  rt.register(parent);
  rt.register(child);
  rt.register(broad);
  assert.equal(rt.canSpawn("coord", "worker", []).ok, true);
  assert.equal(rt.canSpawn("coord", "worker", ["coord", "worker"]).ok, false); // cycle
  assert.equal(rt.canSpawn("coord", "broad", []).ok, false); // shell broader
  assert.equal(rt.canSpawn("coord", "missing", []).ok, false);
});
