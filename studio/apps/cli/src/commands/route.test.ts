import assert from "node:assert/strict";
/**
 * route.test.ts — exit-code mapping for registry-routed commands (CLI-084).
 *
 * `routeViaRegistry` used to collapse EVERY registry-command failure to exit 2
 * ("fail-closed SECURITY/ENGINE block"), even for plain bad-args/not-found engine
 * failures that carry their own, less severe `_exit` on the envelope (e.g. `vault
 * invoke --json` → "interactive; not available over --json"). That falsely looked
 * like a security block to a script checking `$? -eq 2`. These tests lock in the
 * fix: envelope failures pass through the engine's own `_exit` (clamped), and only
 * an actual nemesis verdict block/error still maps to 2.
 */
import { test } from "node:test";

import type {
  EngineClient,
  EngineEnvelope,
  RunOptions,
  SecurityVerdict,
} from "@prometheus/engine-bridge";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { routeViaRegistry } from "./route.js";

function clientReturning(env: EngineEnvelope): EngineClient {
  const ni = (n: string) => () => {
    throw new Error(`fake: ${n} not used here`);
  };
  return {
    runPrometheus: (async (_argv: string[], _o?: RunOptions) =>
      env) as EngineClient["runPrometheus"],
    runNemesis: ni("runNemesis") as EngineClient["runNemesis"],
    gate: ni("gate") as EngineClient["gate"],
    scan: ni("scan") as EngineClient["scan"],
    list: ni("list") as EngineClient["list"],
    matrix: ni("matrix") as EngineClient["matrix"],
    superscan: ni("superscan") as EngineClient["superscan"],
    where: ni("where") as EngineClient["where"],
    info: ni("info") as EngineClient["info"],
    status: ni("status") as EngineClient["status"],
    install: ni("install") as EngineClient["install"],
    uninstall: ni("uninstall") as EngineClient["uninstall"],
    enable: ni("enable") as EngineClient["enable"],
    disable: ni("disable") as EngineClient["disable"],
    vaultStatus: ni("vaultStatus") as EngineClient["vaultStatus"],
    version: ni("version") as EngineClient["version"],
    capabilities: ni("capabilities") as EngineClient["capabilities"],
  } as unknown as EngineClient;
}

function clientWithVerdict(verdict: SecurityVerdict): EngineClient {
  const ni = (n: string) => () => {
    throw new Error(`fake: ${n} not used here`);
  };
  return {
    runPrometheus: ni("runPrometheus") as EngineClient["runPrometheus"],
    runNemesis: ni("runNemesis") as EngineClient["runNemesis"],
    gate: async () => verdict,
    scan: ni("scan") as EngineClient["scan"],
    list: ni("list") as EngineClient["list"],
    matrix: ni("matrix") as EngineClient["matrix"],
    superscan: ni("superscan") as EngineClient["superscan"],
    where: ni("where") as EngineClient["where"],
    info: ni("info") as EngineClient["info"],
    status: ni("status") as EngineClient["status"],
    install: ni("install") as EngineClient["install"],
    uninstall: ni("uninstall") as EngineClient["uninstall"],
    enable: ni("enable") as EngineClient["enable"],
    disable: ni("disable") as EngineClient["disable"],
    vaultStatus: ni("vaultStatus") as EngineClient["vaultStatus"],
    version: ni("version") as EngineClient["version"],
    capabilities: ni("capabilities") as EngineClient["capabilities"],
  } as unknown as EngineClient;
}

test("routeViaRegistry: an ok envelope always exits 0", async () => {
  const client = clientReturning({ command: "vault", ok: true, action: "status" });
  const ctx = makeContext(parseArgs(["vault", "status", "--json"]), client);
  const out = await routeViaRegistry("vault", ctx);
  assert.equal(out.exitCode, 0);
});

test("routeViaRegistry: a generic engine-envelope failure passes through its own _exit (NOT forced to 2)", async () => {
  // mirrors prometheus.py's cmd_vault: "vault invoke is interactive; only status is exposed
  // over --json" — a usage limitation, not a security block. Simulate the engine having
  // computed a less-severe exit (1) for it.
  const client = clientReturning({
    command: "vault",
    ok: false,
    error: "vault invoke is interactive; only `status` is exposed over --json",
    _exit: 1,
  });
  const ctx = makeContext(parseArgs(["vault", "invoke", "--json"]), client);
  const out = await routeViaRegistry("vault", ctx);
  assert.equal(out.exitCode, 1);
});

test("routeViaRegistry: an engine-envelope failure with NO _exit defaults to 1 (generic failure), not 2", async () => {
  const client = clientReturning({ command: "describe", ok: false, error: "unknown id 'nope'" });
  const ctx = makeContext(parseArgs(["describe", "nope", "--json"]), client);
  const out = await routeViaRegistry("describe", ctx);
  assert.equal(out.exitCode, 1);
});

test("routeViaRegistry: an engine-envelope failure with an out-of-range _exit is clamped to 1", async () => {
  const client = clientReturning({ command: "describe", ok: false, error: "boom", _exit: 0 });
  const ctx = makeContext(parseArgs(["describe", "nope", "--json"]), client);
  const out = await routeViaRegistry("describe", ctx);
  assert.equal(out.exitCode, 1);
});

test("routeViaRegistry: a real nemesis block verdict still exits 2 (CI-load-bearing, unaffected)", async () => {
  const verdict: SecurityVerdict = {
    verdict: "block",
    risk_score: 90,
    signed: false,
    findings: [{ severity: "critical", message: "malware" } as SecurityVerdict["findings"][number]],
    scannedAt: "2026-08-18T00:00:00.000Z",
    target: "evil/repo",
  };
  const client = clientWithVerdict(verdict);
  const ctx = makeContext(parseArgs(["gate", "evil/repo", "--json"]), client);
  const out = await routeViaRegistry("gate", ctx);
  assert.equal(out.exitCode, 2);
});
