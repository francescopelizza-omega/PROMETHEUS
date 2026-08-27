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

/**
 * Regression: --dry-run/--yes/--force used to be undeclared in enable/disable's argsSchema, so
 * validateArgs silently stripped them before run() ever saw them (and run() never called
 * globalFlagArgv either) — a typed `/enable foo --dry-run` always performed the REAL re-arm.
 */
test("enable/disable now thread --dry-run / --yes / --force into the engine argv, like install/uninstall", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("enable", ctx(client), rawArgs(["foo"], { "dry-run": true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["--dry-run", "enable", "foo"]);

  await invoke("disable", ctx(client), rawArgs(["foo"], { "dry-run": true, yes: true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["--dry-run", "--yes", "disable", "foo"]);
});

/**
 * Regression: 'bundle' was a bare roSpec with NO argsSchema at all, so every typed flag —
 * --host, and more seriously --dry-run/--yes/--force — was silently dropped; a confirmed
 * `/bundle --force` typed-confirm never actually reached the engine.
 */
test("bundle now forwards --host and the global safety flags (used to drop ALL flags)", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("bundle", ctx(client), rawArgs([], { host: "claude,codex" }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["bundle", "--host", "claude", "--host", "codex"]);

  await invoke("bundle", ctx(client), rawArgs([], { force: true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["--force", "bundle"]);
});

/**
 * Regression: 'sync' used nameSpec's default (forwards only the name), so the engine's real
 * `--to <agents>` scoping flag was silently dropped and every sync fell through to the engine's
 * default of ALL agents with a skills dir — a materially broader outcome than requested.
 */
test("sync now forwards --to (used to always scope to every agent, silently)", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("sync", ctx(client), rawArgs(["my-skill"], { to: "claude,codex" }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["sync", "my-skill", "--to", "claude,codex"]);

  await invoke("sync", ctx(client), rawArgs(["my-skill"]));
  assert.deepEqual(calls.runPrometheus.at(-1), ["sync", "my-skill"]);
});

/**
 * Regression: vault's argsSchema enum was missing "list" — the engine's OWN default action
 * (`prometheus.py`'s `p_vault.add_argument("action", ..., default="list")`) — so
 * `prometheus vault list` (the obvious, documented way to ask for it) was rejected
 * client-side before ever reaching the engine.
 */
test("vault accepts its own default action 'list' (was missing from the enum)", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("vault", ctx(client), rawArgs(["list"]));
  assert.deepEqual(calls.runPrometheus.at(-1), ["vault", "list"]);
});

/**
 * Regression: skills' argsSchema enum only had list/enable/disable/mute — the engine also
 * supports unmute/audit/integrate (its own description even advertises "`audit` = re-scan +
 * pin installed sources"), so `skills unmute <x>` / `skills audit` were rejected client-side.
 * audit's own flags (--restore, --list-quarantine, --defang-*, ...) were also undeclared and
 * silently dropped.
 */
test("skills accepts unmute/audit/integrate + forwards audit's own flags (was missing/dropped)", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("skills", ctx(client), rawArgs(["unmute", "foo"]));
  assert.deepEqual(calls.runPrometheus.at(-1), ["skills", "unmute", "foo"]);

  await invoke("skills", ctx(client), rawArgs(["audit"], { "list-quarantine": true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["skills", "audit", "--list-quarantine"]);

  await invoke("skills", ctx(client), rawArgs(["audit"], { restore: "some-vault-dir" }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["skills", "audit", "--restore", "some-vault-dir"]);
});

/**
 * Regression: 'auto' was a hand-written spec that never merged GLOBAL_FLAG_SPECS nor called
 * globalFlagArgv — a typed `prometheus auto --dry-run` silently performed the REAL mutating
 * maintenance routine (quarantine/re-pin/skill-integrate) with the flag discarded before run()
 * ever saw it. Same "globals leak" bug already fixed for enable/disable/bundle/sync, missed here.
 */
test("auto now threads --dry-run into the engine argv (used to silently drop it)", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("auto", ctx(client), rawArgs([], { "dry-run": true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["--dry-run", "auto"]);

  await invoke("auto", ctx(client), rawArgs([], { "dry-run": true, defang: true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["--dry-run", "auto", "--defang"]);
});

/**
 * Regression: nameSpec() hard-coded argsSchema to NAME_ARG with no seam for a caller to add
 * its own flags — so audit's --revoke and scaffold-skill's --description/--body/--tools/
 * --manual were all declared nowhere, and validateArgs silently stripped them before run()
 * ever saw them (the same "globals leak" bug class already fixed for enable/disable/bundle/
 * sync/auto, missed here because this whole spec shape had no seam at all).
 */
test("audit forwards --revoke (nameSpec used to have no flag seam at all)", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("audit", ctx(client), rawArgs(["someplugin"], { revoke: true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["audit", "someplugin", "--revoke"]);
});

test("scaffold-skill forwards --description/--body/--tools/--manual (used to drop all of them)", async () => {
  const { client, calls } = makeFakeClient();
  await invoke(
    "scaffold-skill",
    ctx(client),
    rawArgs(["my-skill"], {
      description: "Use when X",
      body: "do Y",
      tools: "Read Edit",
      manual: true,
    }),
  );
  assert.deepEqual(calls.runPrometheus.at(-1), [
    "scaffold-skill",
    "my-skill",
    "--description",
    "Use when X",
    "--body",
    "do Y",
    "--tools",
    "Read Edit",
    "--manual",
  ]);
});

/**
 * Regression: `purge` (a nameSpec-based, mutating, DELETE-a-config-dir command) never declared
 * --dry-run/--yes/--force (same "globals leak" bug already fixed for auto), NOR --confirm — the
 * engine's own --yes+--confirm double-gate (`_cmd_purge_json`) could never actually execute
 * through this spec, only ever preview, no matter what the CLI user typed.
 */
test("purge forwards --dry-run/--yes/--force + --confirm (used to drop all of them)", async () => {
  const { client, calls } = makeFakeClient();
  await invoke("purge", ctx(client), rawArgs(["claude"], { "dry-run": true }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["--dry-run", "purge", "claude"]);

  await invoke("purge", ctx(client), rawArgs(["claude"], { yes: true, confirm: "claude" }));
  assert.deepEqual(calls.runPrometheus.at(-1), ["--yes", "purge", "claude", "--confirm", "claude"]);
});

test("nameSpec's call-based commands (where/info/status) are unaffected by the flag seam", async () => {
  const { client, calls } = makeFakeClient();
  const out = await invoke("where", ctx(client), rawArgs(["foo"]));
  assert.equal(out.ok, true);
  assert.deepEqual(calls.runPrometheus, []); // where/info/status go through client.where/info/status, not runPrometheus
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
