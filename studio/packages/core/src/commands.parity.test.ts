import assert from "node:assert/strict";
/**
 * commands.parity.test.ts — proves GUI/CLI parity is STRUCTURAL.
 *
 * The contract (file 11 §5): anything you can do in the GUI you can do in `prom`,
 * and vice-versa, because BOTH route through the one CommandSpec registry. These
 * tests assert that, mechanically:
 *
 *  1. Every prometheus.py subcommand the CLI exposes (the FROZEN engine surface,
 *     file 01 §9, probed from the real binary) has a CommandSpec — no CLI verb is
 *     orphaned, no GUI panel can reach a capability the CLI can't.
 *  2. The C4 nemesis gate is bound.
 *  3. Every GUI-surfaced command is invokable through the router with a FAKE
 *     client (no real spawn) — so a GUI palette entry can never be a dead button.
 *  4. Every CLI-surfaced command is likewise invokable.
 *  5. engineSubcommand strings are stable & serialisable (the parity audit key).
 *
 * Driven by a FAKE EngineClient: no python3/nemesis is spawned.
 */
import { test } from "node:test";

import type {
  EngineClient,
  EngineEnvelope,
  RunOptions,
  SecurityVerdict,
} from "@prometheus/engine-bridge";

import {
  type ArgsSchema,
  COMMAND_SPECS,
  type PrometheusSubcommand,
  type RouterContext,
  coveredPrometheusSubcommands,
  engineTargets,
  getCommand,
  invoke,
  listCommands,
  rawArgs,
} from "./commands.js";

/* ------------------------------------------------------------------ */
/* The FROZEN engine surface (file 01 §9, probed: prometheus.py 0.15) */
/* ------------------------------------------------------------------ */

/** Every prometheus.py subcommand the GUI/CLI is required to cover. */
const ENGINE_SURFACE: readonly PrometheusSubcommand[] = [
  "scan",
  "superscan",
  "matrix",
  "where",
  "list",
  "info",
  "status",
  "audit",
  "doctor",
  "install",
  "uninstall",
  "enable",
  "disable",
  "bundle",
  "skills",
  "inventory",
  "sync",
  "scaffold-skill",
  "schedule",
  "purge",
  "vault",
  "models",
  "apps",
  "worldsim",
  "localai",
  "pentest",
  "wizard",
  // SPECTACULAR power-up surfaces — catalog cards + defensive audit + chat.
  "describe",
  "tutorial",
  "methods",
  "harden",
  "chat",
  "secure",
  "auto",
];

/** A FAKE EngineClient: records calls, never spawns. Every method resolves ok. */
function makeFakeClient(): { client: EngineClient; calls: string[] } {
  const calls: string[] = [];
  const env = (command: string, extra: Record<string, unknown> = {}): EngineEnvelope => ({
    command,
    ok: true,
    ...extra,
  });
  const allow: SecurityVerdict = {
    verdict: "allow",
    risk_score: 0,
    signed: false,
    findings: [],
    scannedAt: "2026-06-16T00:00:00.000Z",
    target: "x",
  };
  const client: EngineClient = {
    runPrometheus: (async (argv: string[], _o?: RunOptions) => {
      calls.push(`runPrometheus:${argv.join(" ")}`);
      const last = argv[argv.length - 1] ?? "unknown";
      if (last === "env.list") return env("env.list", { environments: [{ name: "base" }] });
      if (last === "hw.scan") return env("hw.scan", { usable_weight_gb: 44.8 });
      return env(argv[0] ?? "unknown");
    }) as EngineClient["runPrometheus"],
    runNemesis: (async () => ({
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    })) as EngineClient["runNemesis"],
    gate: async (target: string) => {
      calls.push(`gate:${target}`);
      return { ...allow, target };
    },
    scan: async () => {
      calls.push("scan");
      return env("scan", { agents: [] });
    },
    list: async () => {
      calls.push("list");
      return env("list", { agents: [] });
    },
    matrix: async () => {
      calls.push("matrix");
      return env("matrix");
    },
    superscan: async () => {
      calls.push("superscan");
      return env("superscan");
    },
    where: async (n: string) => {
      calls.push(`where:${n}`);
      return env("where");
    },
    info: async (n: string) => {
      calls.push(`info:${n}`);
      return env("info");
    },
    status: async (n: string) => {
      calls.push(`status:${n}`);
      return env("status");
    },
    install: async (n: string) => {
      calls.push(`install:${n}`);
      return env("install");
    },
    uninstall: async (n: string) => {
      calls.push(`uninstall:${n}`);
      return env("uninstall");
    },
    enable: async (n: string) => {
      calls.push(`enable:${n}`);
      return env("enable");
    },
    disable: async (n: string) => {
      calls.push(`disable:${n}`);
      return env("disable");
    },
    vaultStatus: async () => {
      calls.push("vaultStatus");
      return env("vault");
    },
    version: (async () => {
      throw new Error("fake: version not used here");
    }) as EngineClient["version"],
    capabilities: (async () => {
      throw new Error("fake: capabilities not used here");
    }) as EngineClient["capabilities"],
  };
  return { client, calls };
}

function ctx(client: EngineClient): RouterContext {
  return { client };
}

/** Build a placeholder positional list that satisfies a spec's required args. */
function satisfy(schema: ArgsSchema): string[] {
  const pos = schema.positionals ?? [];
  return pos.map((p, i) => {
    if (p.type === "enum" && p.choices && p.choices.length > 0) return p.choices[0]!;
    if (p.type === "number") return "1";
    return p.required ? `arg${i}` : `arg${i}`;
  });
}

/* ------------------------------------------------------------------ */
/* 1. Full engine-surface coverage                                    */
/* ------------------------------------------------------------------ */

test("PARITY: every prometheus.py subcommand in the engine surface has a CommandSpec", () => {
  const covered = coveredPrometheusSubcommands();
  const missing = ENGINE_SURFACE.filter((s) => !covered.has(s));
  assert.deepEqual(missing, [], `engine subcommands with NO CommandSpec: ${missing.join(", ")}`);
});

test("PARITY: the C4 nemesis gate is bound", () => {
  const hasGate = COMMAND_SPECS.some(
    (c) => c.binding.kind === "nemesis" && c.binding.verb === "gate",
  );
  assert.ok(hasGate, "registry must bind `nemesis gate` (C4 arbitrary-target gate)");
  assert.equal(getCommand("gate")?.engineSubcommand, "nemesis:gate");
  // the canonical FREE threat scan, surfaced on BOTH the CLI (`prom nemesis` / `/nemesis`) and
  // the app GUI (Security route) — must reach the SAME fail-closed nemesis gate.
  const nemesis = getCommand("nemesis");
  assert.ok(nemesis, "registry must expose the `nemesis` free-scan spec");
  assert.equal(nemesis?.engineSubcommand, "nemesis:gate");
  assert.ok(
    nemesis?.surfaces.includes("GUI") && nemesis?.surfaces.includes("CLI"),
    "nemesis scan must be on both surfaces (parity)",
  );
});

test("PARITY: sidecar (env-list / model-hw) and provider router are present", () => {
  assert.equal(getCommand("env-list")?.engineSubcommand, "sidecar:envmgr.env.list");
  assert.equal(getCommand("model-hw")?.engineSubcommand, "sidecar:modelhub.hw.scan");
  assert.equal(getCommand("provider-list")?.engineSubcommand, "core:provider-list");
});

/* ------------------------------------------------------------------ */
/* 2. Both surfaces are invokable — no dead palette entry / CLI verb  */
/* ------------------------------------------------------------------ */

test("PARITY: every GUI-surfaced command is invokable through the router", async () => {
  const gui = listCommands("GUI");
  assert.ok(gui.length >= 20, "GUI must surface the bulk of the registry");
  for (const cmd of gui) {
    const { client } = makeFakeClient();
    const res = await invoke(cmd.id, ctx(client), rawArgs(satisfy(cmd.argsSchema)));
    assert.equal(res.id, cmd.id, `GUI command ${cmd.id} routed to wrong id`);
    assert.equal(res.ok, true, `GUI command ${cmd.id} must be invokable (ok)`);
  }
});

test("PARITY: every CLI-surfaced command is invokable through the router", async () => {
  const cli = listCommands("CLI");
  // The CLI is the superset surface (it also owns wizard/tui-only verbs).
  assert.ok(cli.length >= listCommands("GUI").length);
  for (const cmd of cli) {
    const { client } = makeFakeClient();
    const res = await invoke(cmd.id, ctx(client), rawArgs(satisfy(cmd.argsSchema)));
    assert.equal(res.ok, true, `CLI command ${cmd.id} must be invokable (ok)`);
  }
});

test("PARITY: the GUI/CLI split is intentional — only wizard is CLI-exclusive", () => {
  const guiIds = new Set(listCommands("GUI").map((c) => c.id));
  const cliOnly = listCommands("CLI")
    .filter((c) => !guiIds.has(c.id))
    .map((c) => c.id);
  // file 11 §2: wizard is the interactive TUI menu — CLI/TUI only.
  assert.deepEqual(cliOnly.sort(), ["wizard"]);
});

test("PARITY: every spec declares at least one surface and a stable engineSubcommand", () => {
  const seen = new Set<string>();
  for (const c of COMMAND_SPECS) {
    assert.ok(c.surfaces.length >= 1, `${c.id} exposes no surface`);
    assert.ok(c.engineSubcommand.length > 0, `${c.id} has empty engineSubcommand`);
    assert.ok(!seen.has(c.id), `duplicate command id ${c.id}`);
    seen.add(c.id);
  }
  // engineTargets() is the serialisable audit key list
  assert.equal(engineTargets().length, COMMAND_SPECS.length);
});
