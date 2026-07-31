import assert from "node:assert/strict";
/**
 * commands.test.ts — unit tests for the parity router + argsSchema validation.
 *
 * Covers: argument validation (required/number/enum/surplus), the router's
 * validate-then-route flow, routing through the injected client (NO real spawn),
 * the C5 fail-closed gate path (an 'error' verdict => command NOT ok), the
 * install flag plumbing (--dry-run/--force), and lookup/listing helpers.
 */
import { test } from "node:test";

import type {
  EngineClient,
  EngineEnvelope,
  RunOptions,
  SecurityVerdict,
} from "@prometheus/engine-bridge";

import {
  type RouterContext,
  commandsByGroup,
  getCommand,
  invoke,
  listCommands,
  rawArgs,
  validateArgs,
} from "./commands.js";

/* ----------------------------- fake client ----------------------------- */

interface Calls {
  runPrometheus: string[][];
  gate: string[];
  install: Array<{ name: string; dryRun?: boolean; forced?: boolean }>;
}

function makeFakeClient(overrides: Partial<EngineClient> = {}): {
  client: EngineClient;
  calls: Calls;
} {
  const calls: Calls = { runPrometheus: [], gate: [], install: [] };
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
  const ni = (n: string) => () => {
    throw new Error(`fake: ${n} not used here`);
  };
  const client: EngineClient = {
    runPrometheus: (async (argv: string[], _o?: RunOptions) => {
      calls.runPrometheus.push(argv);
      const last = argv[argv.length - 1] ?? "";
      if (last === "env.list")
        return env("env.list", { environments: [{ name: "base" }, { name: "ml" }] });
      if (last === "hw.scan") return env("hw.scan", { usable_weight_gb: 44.8 });
      return env(argv[0] ?? "unknown");
    }) as EngineClient["runPrometheus"],
    runNemesis: ni("runNemesis") as EngineClient["runNemesis"],
    gate: async (target: string) => {
      calls.gate.push(target);
      return { ...allow, target };
    },
    scan: async () => env("scan", { agents: [] }),
    list: async () => env("list", { agents: [] }),
    matrix: async () => env("matrix"),
    superscan: async () => env("superscan"),
    where: async () => env("where"),
    info: async () => env("info"),
    status: async () => env("status"),
    install: async (name: string, opts?: RunOptions & { dryRun?: boolean; forced?: boolean }) => {
      calls.install.push({ name, dryRun: opts?.dryRun, forced: opts?.forced });
      return env("install");
    },
    uninstall: async () => env("uninstall"),
    enable: async () => env("enable"),
    disable: async () => env("disable"),
    vaultStatus: async () => env("vault"),
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

function ctx(client: EngineClient): RouterContext {
  return { client };
}

/* --------------------------- validateArgs ------------------------------ */

test("validateArgs: required positional missing => error", () => {
  const r = validateArgs(
    { positionals: [{ name: "name", kind: "positional", type: "string", required: true }] },
    rawArgs([]),
  );
  assert.equal(r.ok, false);
  assert.match(r.errors[0]!, /missing required argument <name>/);
});

test("validateArgs: number coercion rejects non-numbers", () => {
  const r = validateArgs(
    { positionals: [{ name: "port", kind: "positional", type: "number", required: true }] },
    rawArgs(["abc"]),
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /must be a number/);
  const ok = validateArgs(
    { positionals: [{ name: "port", kind: "positional", type: "number", required: true }] },
    rawArgs(["8080"]),
  );
  assert.equal(ok.ok, true);
});

test("validateArgs: enum rejects out-of-set, accepts valid", () => {
  const schema = {
    positionals: [
      {
        name: "action",
        kind: "positional" as const,
        type: "enum" as const,
        required: true,
        choices: ["status", "rollback"] as const,
      },
    ],
  };
  assert.equal(validateArgs(schema, rawArgs(["nope"])).ok, false);
  assert.equal(validateArgs(schema, rawArgs(["status"])).ok, true);
});

test("validateArgs: required flag missing => error; boolean flag parses", () => {
  const schema = {
    flags: [
      { name: "to", kind: "flag" as const, type: "string" as const, required: true },
      { name: "force", kind: "flag" as const, type: "boolean" as const },
    ],
  };
  const miss = validateArgs(schema, rawArgs([], {}));
  assert.equal(miss.ok, false);
  assert.match(miss.errors.join(" "), /missing required flag --to/);
  const ok = validateArgs(schema, rawArgs([], { to: "cursor", force: true }));
  assert.equal(ok.ok, true);
  assert.equal(ok.parsed.flags.force, true);
  assert.equal(ok.parsed.flags.to, "cursor");
});

test("validateArgs: surplus positionals are preserved (variadic tails)", () => {
  const r = validateArgs(
    { positionals: [{ name: "action", kind: "positional", type: "string", required: false }] },
    rawArgs(["run", "--", "nmap", "-sV"]),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.parsed.positionals, ["run", "--", "nmap", "-sV"]);
});

/* ------------------------------- router -------------------------------- */

test("invoke: unknown id throws", async () => {
  const { client } = makeFakeClient();
  await assert.rejects(() => invoke("nope", ctx(client)), /unknown command: nope/);
});

test("invoke: invalid args throw before routing (router validates first)", async () => {
  const { client, calls } = makeFakeClient();
  await assert.rejects(
    () => invoke("info", ctx(client), rawArgs([])),
    /invalid arguments for "info"/,
  );
  // nothing was routed
  assert.equal(calls.runPrometheus.length, 0);
});

test("invoke: scan routes through client.scan and is ok", async () => {
  const { client } = makeFakeClient();
  const res = await invoke("scan", ctx(client));
  assert.equal(res.id, "scan");
  assert.equal(res.ok, true);
});

test("invoke: info routes with the validated name positional", async () => {
  const seen: string[] = [];
  const { client } = makeFakeClient({
    info: async (n: string) => {
      seen.push(n);
      return { command: "info", ok: true };
    },
  });
  const res = await invoke("info", ctx(client), rawArgs(["rust-analyzer"]));
  assert.equal(res.ok, true);
  assert.deepEqual(seen, ["rust-analyzer"]);
});

test("invoke: env-list / model-hw route through the sidecar passthrough", async () => {
  const { client, calls } = makeFakeClient();
  const e = await invoke("env-list", ctx(client));
  assert.match(e.summary, /2 environments/);
  const h = await invoke("model-hw", ctx(client));
  assert.match(h.summary, /44.8 GB usable/);
  assert.deepEqual(calls.runPrometheus, [
    ["sidecar", "envmgr", "env.list"],
    ["sidecar", "modelhub", "hw.scan"],
  ]);
});

test("invoke: manager command forwards parsed positionals verbatim", async () => {
  const { client, calls } = makeFakeClient();
  const res = await invoke("apps", ctx(client), rawArgs(["install", "yt-dlp"]));
  assert.equal(res.ok, true);
  assert.deepEqual(calls.runPrometheus, [["apps", "install", "yt-dlp"]]);
});

/* ----------------------- gate / fail-closed (C5) ----------------------- */

test("invoke: gate renders an allow verdict and is ok", async () => {
  const { client, calls } = makeFakeClient();
  const res = await invoke("gate", ctx(client), rawArgs(["owner/repo"]));
  assert.deepEqual(calls.gate, ["owner/repo"]);
  assert.equal(res.ok, true);
  assert.equal(res.verdict?.verdict, "allow");
  assert.match(res.summary, /gate owner\/repo: allow/);
});

test("invoke: gate is FAIL-CLOSED — an 'error' verdict makes the command NOT ok (C5)", async () => {
  const failClosed: SecurityVerdict = {
    verdict: "error",
    risk_score: 100,
    signed: false,
    findings: [{ klass: "malware", severity: "critical", rule: "nemesis-unavailable", where: "x" }],
    scannedAt: "2026-06-16T00:00:00.000Z",
    target: "bad",
  };
  const { client } = makeFakeClient({ gate: async () => failClosed });
  const res = await invoke("gate", ctx(client), rawArgs(["bad"]));
  assert.equal(res.ok, false, "error verdict must not be ok");
  assert.equal(res.verdict?.verdict, "error");
});

test("invoke: secure-scan also fail-closes on a 'block' verdict", async () => {
  const blocked: SecurityVerdict = {
    verdict: "block",
    risk_score: 90,
    signed: false,
    findings: [],
    scannedAt: "2026-06-16T00:00:00.000Z",
    target: "evil",
  };
  const { client } = makeFakeClient({ gate: async () => blocked });
  const res = await invoke("secure-scan", ctx(client), rawArgs(["evil"]));
  assert.equal(res.ok, false);
  assert.equal(res.verdict?.verdict, "block");
});

/* ----------------------- install flag plumbing ------------------------- */

test("invoke: install threads --dry-run / --force into the engine argv (globals BEFORE the verb, never auto-supplied)", async () => {
  const { client, calls } = makeFakeClient();
  // install now routes through runPrometheus so the FULL flag surface forwards (parity
  // with the GUI LifecycleClient): globals come BEFORE the subcommand, nothing is auto-added.
  await invoke("install", ctx(client), rawArgs(["rust-analyzer"], { "dry-run": true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["--dry-run", "install", "rust-analyzer"]);
  assert.equal(calls.install.length, 0); // the typed facade is no longer the route

  await invoke("install", ctx(client), rawArgs(["sketchy"], { force: true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["--force", "install", "sketchy"]);

  // the rich affordances ride too: --only / --skip / --host(repeatable) / --arm.
  await invoke(
    "install",
    ctx(client),
    rawArgs(["pluginz"], { only: "a,b", host: "claude,codex", arm: true }),
  );
  assert.deepEqual(calls.runPrometheus.at(-1), [
    "install",
    "pluginz",
    "--host",
    "claude",
    "--host",
    "codex",
    "--only",
    "a,b",
    "--arm",
  ]);
});

test("invoke: install requires a name positional", async () => {
  const { client } = makeFakeClient();
  await assert.rejects(() => invoke("install", ctx(client), rawArgs([])), /invalid arguments/);
});

test("manager flag-forward: apps --path / models config --set-root / pentest --kali reach the engine", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("apps", ctx(client), rawArgs(["install", "yt-dlp"], { path: "/opt/x" }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["apps", "install", "yt-dlp", "--path", "/opt/x"]);

  await invoke("models", ctx(client), rawArgs(["config"], { "set-root": "/m", show: true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["models", "config", "--set-root", "/m", "--show"]);

  await invoke("pentest", ctx(client), rawArgs(["build"], { kali: true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["pentest", "build", "--kali"]);
});

test("globals leak fix: --no-gate / --gate-mode forward (BEFORE the subcommand) to a manager spec", async () => {
  const { client, calls } = makeFakeClient();
  await invoke(
    "apps",
    ctx(client),
    rawArgs(["install", "x"], { "no-gate": true, "gate-mode": "warn" }),
  );
  assert.deepEqual(calls.runPrometheus.at(-1), [
    "--no-gate",
    "--gate-mode",
    "warn",
    "apps",
    "install",
    "x",
  ]);
});

test("enable/disable forward --component and --host (the GUI toggle affordances)", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("enable", ctx(client), rawArgs(["myplugin"], { component: "mcp", host: "claude" }));
  assert.deepEqual(calls.runPrometheus.at(-1), [
    "enable",
    "myplugin",
    "--component",
    "mcp",
    "--host",
    "claude",
  ]);

  await invoke("disable", ctx(client), rawArgs(["myplugin"], { only: "hooks-x" }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["disable", "myplugin", "--only", "hooks-x"]);
});

/* --------------------------- lookup helpers ---------------------------- */

test("getCommand / listCommands / commandsByGroup", () => {
  assert.equal(getCommand("scan")?.group, "inventory");
  assert.equal(getCommand("gate")?.group, "security");
  assert.equal(getCommand("nope"), undefined);

  // listing by surface narrows
  assert.ok(listCommands("GUI").length >= 1);
  assert.ok(listCommands().length >= listCommands("GUI").length);

  const security = commandsByGroup("security")
    .map((c) => c.id)
    .sort();
  assert.ok(security.includes("gate"));
  assert.ok(security.includes("audit"));
});

test("registry is immutable (frozen)", () => {
  const list = listCommands();
  assert.throws(() => {
    (list as unknown as unknown[]).push({});
  });
});
