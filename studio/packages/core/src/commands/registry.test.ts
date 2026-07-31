import assert from "node:assert/strict";
/**
 * registry.test.ts — the SHARED command registry.
 *
 * Drives the registry with a FAKE EngineClient (no real python3/nemesis spawn),
 * asserting: registry shape (ids/groups/lookup), that each command routes through
 * the injected client, the scan summary counts present agents, gate renders the
 * nemesis verdict (incl. fail-closed "error" => not ok), provider-list applies the
 * C11 promotion + Tier-A-first sort, and arg-required commands reject empty argv.
 */
import { test } from "node:test";

import type {
  EngineClient,
  EngineEnvelope,
  RunOptions,
  SecurityVerdict,
} from "@prometheus/engine-bridge";

import { existsSync } from "node:fs";
import { DEFAULT_PROVIDERS_CONFIG } from "../providers/policy.js";
import {
  COMMANDS,
  type CommandContext,
  commandsByGroup,
  getCommand,
  listCommands,
  runCommandById,
} from "./registry.js";

/** A record of which client methods were called, for routing assertions. */
interface Calls {
  scan: number;
  list: number;
  gate: string[];
  runPrometheus: string[][];
}

function makeFakeClient(overrides: Partial<EngineClient> = {}): {
  client: EngineClient;
  calls: Calls;
} {
  const calls: Calls = { scan: 0, list: 0, gate: [], runPrometheus: [] };
  const env = (command: string, extra: Record<string, unknown> = {}): EngineEnvelope => ({
    command,
    ok: true,
    ...extra,
  });

  const notImpl = (name: string) => () => {
    throw new Error(`fake client: ${name} not implemented for this test`);
  };

  const client: EngineClient = {
    scan: async (_opts?: RunOptions) => {
      calls.scan += 1;
      return env("scan", {
        agents: [
          { name: "claude", present: true },
          { name: "aider", present: false },
          { name: "copilot", present: true },
        ],
      });
    },
    list: async (_opts?: RunOptions) => {
      calls.list += 1;
      return env("list", { agents: [] });
    },
    gate: async (target: string, _opts?: RunOptions): Promise<SecurityVerdict> => {
      calls.gate.push(target);
      return {
        verdict: "allow",
        risk_score: 0,
        signed: false,
        findings: [],
        scannedAt: "2026-06-15T00:00:00.000Z",
        target,
      };
    },
    runPrometheus: (async (argv: string[], _opts?: RunOptions) => {
      calls.runPrometheus.push(argv);
      const verb = argv[argv.length - 1];
      if (verb === "env.list")
        return env("env.list", { environments: [{ name: "base" }, { name: "ml" }] });
      if (verb === "hw.scan") return env("hw.scan", { usable_weight_gb: 44.8 });
      return env(verb ?? "unknown");
    }) as EngineClient["runPrometheus"],
    runNemesis: notImpl("runNemesis") as EngineClient["runNemesis"],
    info: notImpl("info") as EngineClient["info"],
    status: notImpl("status") as EngineClient["status"],
    matrix: notImpl("matrix") as EngineClient["matrix"],
    superscan: notImpl("superscan") as EngineClient["superscan"],
    where: notImpl("where") as EngineClient["where"],
    install: notImpl("install") as EngineClient["install"],
    uninstall: notImpl("uninstall") as EngineClient["uninstall"],
    enable: notImpl("enable") as EngineClient["enable"],
    disable: notImpl("disable") as EngineClient["disable"],
    vaultStatus: notImpl("vaultStatus") as EngineClient["vaultStatus"],
    version: (async () => {
      throw new Error("fake: version not used here");
    }) as EngineClient["version"],
    capabilities: (async () => {
      throw new Error("fake: capabilities not used here");
    }) as EngineClient["capabilities"],
    ...overrides,
  };
  return { client, calls };
}

function ctx(client: EngineClient, args: string[] = []): CommandContext {
  return { client, args };
}

test("registry shape: stable ids, groups, and lookup", () => {
  const ids = listCommands().map((c) => c.id);
  for (const want of ["scan", "list", "gate", "env-list", "model-hw", "provider-list"]) {
    assert.ok(ids.includes(want), `registry must seed "${want}"`);
  }
  assert.equal(getCommand("scan")?.group, "inventory");
  assert.equal(getCommand("gate")?.group, "security");
  assert.equal(getCommand("env-list")?.group, "environments");
  assert.equal(getCommand("model-hw")?.group, "models");
  assert.equal(getCommand("provider-list")?.group, "providers");
  assert.equal(getCommand("nope"), undefined);
  // commands are immutable
  assert.throws(() => {
    (COMMANDS as unknown as unknown[]).push({});
  });
});

test("commandsByGroup filters correctly", () => {
  assert.deepEqual(
    commandsByGroup("security").map((c) => c.id),
    ["gate"],
  );
  assert.ok(commandsByGroup("inventory").length >= 2);
});

test("scan routes through client.scan and summarises present agents", async () => {
  const { client, calls } = makeFakeClient();
  const res = await runCommandById("scan", ctx(client));
  assert.equal(calls.scan, 1);
  assert.equal(res.ok, true);
  assert.match(res.summary, /2\/3 agents present/);
});

test("list routes through client.list", async () => {
  const { client, calls } = makeFakeClient();
  const res = await getCommand("list")?.run(ctx(client));
  assert.equal(calls.list, 1);
  assert.equal(res.ok, true);
});

test("gate renders an allow verdict and is ok", async () => {
  const { client, calls } = makeFakeClient();
  const res = await runCommandById("gate", ctx(client, ["owner/repo"]));
  assert.deepEqual(calls.gate, ["owner/repo"]);
  assert.equal(res.ok, true);
  assert.equal(res.verdict?.verdict, "allow");
  assert.match(res.summary, /gate owner\/repo: allow/);
});

test("gate is fail-closed: an 'error' verdict makes the command NOT ok", async () => {
  const failClosed: SecurityVerdict = {
    verdict: "error",
    risk_score: 100,
    signed: false,
    findings: [{ klass: "malware", severity: "critical", rule: "nemesis-unavailable", where: "x" }],
    scannedAt: "2026-06-15T00:00:00.000Z",
    target: "bad",
  };
  const { client } = makeFakeClient({
    gate: async () => failClosed,
  });
  const res = await runCommandById("gate", ctx(client, ["bad"]));
  assert.equal(res.ok, false, "error verdict must not be ok");
  assert.equal(res.verdict?.verdict, "error");
});

test("gate without a target argument rejects", async () => {
  const { client } = makeFakeClient();
  await assert.rejects(() => runCommandById("gate", ctx(client, [])), /requires a name/);
});

test("env-list and model-hw route through the sidecar passthrough", async () => {
  const { client, calls } = makeFakeClient();
  const e = await runCommandById("env-list", ctx(client));
  assert.match(e.summary, /2 environments/);
  const h = await runCommandById("model-hw", ctx(client));
  assert.match(h.summary, /44.8 GB usable/);
  assert.deepEqual(calls.runPrometheus, [
    ["sidecar", "envmgr", "env.list"],
    ["sidecar", "modelhub", "hw.scan"],
  ]);
});

test("runCommandById throws on an unknown id", async () => {
  const { client } = makeFakeClient();
  await assert.rejects(() => runCommandById("does-not-exist", ctx(client)), /unknown command/);
});

test("provider-list applies C11 promotion + Tier-A-first sort (real config)", async (t) => {
  if (!existsSync(DEFAULT_PROVIDERS_CONFIG)) {
    t.skip("providers config not present");
    return;
  }
  const { client } = makeFakeClient();
  // Include BOTH a chatgpt-covering seat AND the old claude-code-oauth capability,
  // to prove (a) ChatGPT promotes to B, and (b) Claude does NOT — Anthropic mandates
  // API billing for third-party IDE use, so Claude has no subscription→B path (user policy).
  const res = await runCommandById("provider-list", {
    ...ctx(client),
    promotionContext: { coveredCapabilities: ["chatgpt-plus-or-codex-seat", "claude-code-oauth"] },
  });
  assert.equal(res.ok, true);
  const rows = res.providers!;
  assert.ok(rows.length >= 5);
  // first row must be Tier-A (the local escape hatch)
  assert.equal(rows[0]?.tier, "A");
  assert.equal(rows[0]?.provider.id, "local");
  // ChatGPT promoted to B by its covering seat capability
  const chatgptRow = rows.find((r) => r.provider.id === "chatgpt");
  if (chatgptRow) {
    assert.equal(chatgptRow.tier, "B");
    assert.equal(chatgptRow.costLight, "blue");
    assert.equal(chatgptRow.needsCostWarning, false);
  }
  // Claude stays Tier C even with a claude-code-oauth capability present (no third-party-IDE subscription path)
  const claudeRow = rows.find((r) => r.provider.id === "claude");
  if (claudeRow) {
    assert.equal(claudeRow.tier, "C");
    assert.equal(claudeRow.costLight, "red");
    assert.equal(claudeRow.needsCostWarning, true);
  }
  // tiers are non-decreasing (A...B...C)
  const order = { A: 0, B: 1, C: 2 } as const;
  for (let i = 1; i < rows.length; i++) {
    assert.ok(order[rows[i]?.tier] >= order[rows[i - 1]?.tier], "tiers must be sorted A->C");
  }
});
