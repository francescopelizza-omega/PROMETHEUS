/**
 * command-exec.test.ts — session verb execution: parity routing + never-force.
 *
 * Deterministic: a FAKE EngineClient (records calls, never spawns python/nemesis)
 * is injected as the session client, and the typed-confirm prompt is a fake. We
 * assert the three contracts:
 *   1. a single-token spec verb routes through the canonical router over the
 *      SESSION's client (parity — the GUI's exact path), sharing one gateway;
 *   2. never-force holds a mutating --force behind a typed confirm (decline →
 *      blocked, accept → runs); a force-forbidding profile (ci) hard-blocks;
 *   3. an engine error is rendered friendly (no crash, no raw stack), exit 2.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type EngineClient,
  type EngineEnvelope,
  EngineError,
  type RunOptions,
  type SecurityVerdict,
} from "@prometheus/engine-bridge";

import { type SessionCtx, execVerb } from "./command-exec.js";

/* ------------------------------------------------------------------ */
/* A FAKE EngineClient: records calls, never spawns. Only the methods  */
/* the routed verbs in these tests touch are real; the rest throw if   */
/* unexpectedly reached (so a wrong route is loud, not silent).        */
/* ------------------------------------------------------------------ */
function makeFakeClient(opts: { installThrows?: boolean | "engine-timeout" } = {}): {
  client: EngineClient;
  calls: string[];
} {
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
    scannedAt: "2026-06-22T00:00:00.000Z",
    target: "x",
  };
  const unexpected = (name: string) =>
    (async () => {
      throw new Error(`fake: ${name} unexpectedly called`);
    }) as never;
  const client = {
    // EVERY mutating spec verb (install/uninstall/enable/disable + describe/…) now
    // routes through runPrometheus so the FULL flag surface (--only/--skip/--host/…)
    // forwards verbatim (parity with the GUI's LifecycleClient argv).
    runPrometheus: (async (argv: string[], _o?: RunOptions) => {
      calls.push(`runPrometheus:${argv.join(" ")}`);
      if (argv.includes("install")) {
        if (opts.installThrows === "engine-timeout") {
          throw EngineError.fromKind("timeout", "nemesis sidecar timed out");
        }
        if (opts.installThrows) throw new Error("nemesis sidecar timed out");
      }
      return env(argv.find((a) => !a.startsWith("-")) ?? "unknown");
    }) as EngineClient["runPrometheus"],
    // the typed facade install() is no longer the install ROUTE (kept for the interface).
    install: async (n: string, o?: RunOptions & { dryRun?: boolean; forced?: boolean }) => {
      calls.push(`install:${n}${o?.forced ? ":forced" : ""}${o?.dryRun ? ":dry" : ""}`);
      return env("install");
    },
    gate: async (target: string) => {
      calls.push(`gate:${target}`);
      return { ...allow, target };
    },
    // Methods that should NOT be reached by these tests — loud if they are.
    runNemesis: unexpected("runNemesis"),
    scan: unexpected("scan"),
    list: unexpected("list"),
    version: unexpected("version"),
    capabilities: unexpected("capabilities"),
  } as unknown as EngineClient;
  return { client, calls };
}

/** A SessionCtx whose confirm() answers a fixed yes/no and captures the prompt. */
function makeCtx(
  client: EngineClient,
  opts: { confirm?: boolean; profile?: string } = {},
): { ctx: SessionCtx; prompts: string[]; out: string[] } {
  const prompts: string[] = [];
  const out: string[] = [];
  const ctx: SessionCtx = {
    client,
    json: false,
    profile: opts.profile,
    confirm: async (prompt) => {
      prompts.push(prompt);
      return opts.confirm ?? false;
    },
    write: (text) => out.push(text),
  };
  return { ctx, prompts, out };
}

test("parity: a single-token spec verb routes through invoke() over the SESSION client", async () => {
  const { client, calls } = makeFakeClient();
  const { ctx } = makeCtx(client);

  const out = await execVerb(["describe", "yt-dlp"], ctx);

  assert.equal(out.exitCode, 0);
  // it hit the canonical router → the SHARED fake client (not a fresh spawn).
  assert.deepEqual(calls, ["runPrometheus:describe yt-dlp"]);
  assert.match(out.text ?? "", /describe/);
});

test("never-force: mutating --force without confirm is BLOCKED (verb never runs)", async () => {
  const { client, calls } = makeFakeClient();
  const { ctx, prompts } = makeCtx(client, { confirm: false });

  const out = await execVerb(["install", "foo", "--force"], ctx);

  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "force override declined — verb not run");
  // the user WAS prompted (typed-confirm surfaced)…
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /Type FORCE/);
  // …and the engine was NEVER touched (gate-first held it).
  assert.deepEqual(calls, []);
});

test("never-force: typed-confirm ACCEPTED lets the forced verb through (forced:true)", async () => {
  const { client, calls } = makeFakeClient();
  const { ctx, prompts } = makeCtx(client, { confirm: true });

  const out = await execVerb(["install", "foo", "--force"], ctx);

  assert.equal(out.exitCode, 0);
  assert.equal(prompts.length, 1);
  // the override reached the engine as --force in the argv (JS never pre-judges — C5).
  assert.deepEqual(calls, ["runPrometheus:--force install foo"]);
});

test("never-force: a force-forbidding profile (ci) HARD-blocks — no confirm offered", async () => {
  const prev = process.env.PROM_ALLOW_FORCE;
  process.env.PROM_ALLOW_FORCE = undefined;
  // biome-ignore lint/performance/noDelete: ensure the override env is truly unset for the test
  delete process.env.PROM_ALLOW_FORCE;
  try {
    const { client, calls } = makeFakeClient();
    const { ctx, prompts } = makeCtx(client, { confirm: true, profile: "ci" });

    const out = await execVerb(["install", "foo", "--force"], ctx);

    assert.equal(out.exitCode, 2);
    assert.match((out.json as { error: string }).error, /blocked under the 'ci' profile/);
    // hard block: no typed-confirm is even offered (no human to satisfy it), no engine call.
    assert.equal(prompts.length, 0);
    assert.deepEqual(calls, []);
  } finally {
    if (prev !== undefined) process.env.PROM_ALLOW_FORCE = prev;
  }
});

test("never-force: --force on a READ-ONLY verb is inert (no confirm, runs normally)", async () => {
  const { client, calls } = makeFakeClient();
  const { ctx, prompts } = makeCtx(client, { confirm: false });

  // `describe` does not mutate → its --force never triggers the gate.
  const out = await execVerb(["describe", "foo", "--force"], ctx);

  assert.equal(out.exitCode, 0);
  assert.equal(prompts.length, 0);
  assert.deepEqual(calls, ["runPrometheus:describe foo"]);
});

test("crash-free: an engine error renders a friendly outcome (no throw)", async () => {
  const { client } = makeFakeClient({ installThrows: true });
  const { ctx } = makeCtx(client, { confirm: true });

  // install is forced+confirmed so it reaches the engine, which throws. The turn
  // must NOT reject — outcomeFromError renders a friendly line (a plain Error maps
  // to exit 1; an EngineError fail-closed would map to 2 — never a silent 0).
  const out = await execVerb(["install", "foo", "--force"], ctx);

  assert.notEqual(out.exitCode, 0);
  assert.match(out.text ?? "", /timed out/);
  assert.equal((out.json as { ok: boolean }).ok, false);
});

test("crash-free: an EngineError fail-closed maps to exit 2 (C5, no throw)", async () => {
  const { client } = makeFakeClient({ installThrows: "engine-timeout" });
  const { ctx } = makeCtx(client, { confirm: true });

  const out = await execVerb(["install", "foo", "--force"], ctx);

  // a fail-closed transport error never exits 0 — it BLOCKS (exit 2).
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /timed out/);
  assert.equal((out.json as { ok: boolean }).ok, false);
});

test("empty input is a no-op the session swallows (exit 0, no client call)", async () => {
  const { client, calls } = makeFakeClient();
  const { ctx } = makeCtx(client);

  const out = await execVerb(
    ["", "  "].map((s) => s.trim()),
    ctx,
  );

  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, []);
});

test("dry-run flag is forwarded to the routed spec (forced:false, dry:true)", async () => {
  const { client, calls } = makeFakeClient();
  const { ctx } = makeCtx(client);

  const out = await execVerb(["install", "foo", "--dry-run"], ctx);

  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, ["runPrometheus:--dry-run install foo"]);
});
