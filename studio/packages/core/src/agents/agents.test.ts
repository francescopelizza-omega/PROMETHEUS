/**
 * agents.test.ts — sandbox guards + ToolBroker + orchestrator loop + runtime spawn.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ToolAnnotations } from "../mcp/server/index.js";
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
