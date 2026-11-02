/**
 * freellmapi-cmd.test.ts — the CLI half of the guided FreeLLMAPI procedure.
 *
 * The engine is a stub that records argv: nothing here fetches, gates, builds or starts anything.
 * What is pinned is what only this file decides — that the gateway key reaches the keychain
 * path and nowhere else, that a session never gets the terminal handed away, and that the
 * engine's refusal reasons reach the human.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { EngineEnvelope } from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import { type FreellmapiDeps, runFreellmapiCommand } from "./freellmapi-cmd.js";

setColorEnabled(false);

const KEY = "freellmapi-0123456789abcdef0123456789abcdef0123456789abcdef";

function ctx(
  sub: string | undefined,
  flags: Record<string, string | true> = {},
  yes = false,
): CliContext {
  const args: ParsedArgs = {
    command: sub ? ["freellmapi", sub] : ["freellmapi"],
    positionals: [],
    json: false,
    noColor: true,
    help: false,
    version: false,
    repl: false,
    dryRun: false,
    yes,
    strict: false,
    force: false,
    noGate: false,
    verbose: false,
    quiet: false,
    flags,
  };
  return { client: {} as CliContext["client"], json: false, quiet: false, args };
}

function deps(over: Partial<FreellmapiDeps> & { envelope?: EngineEnvelope } = {}) {
  const engine: string[][] = [];
  const terminal: string[][] = [];
  const stored: string[] = [];
  const d: FreellmapiDeps = {
    engineJson: async (argv) => {
      engine.push(argv);
      return over.envelope ?? { command: "freellmapi", ok: true };
    },
    engineOnTerminal: async (argv) => {
      terminal.push(argv);
      return 0;
    },
    interactive: false,
    connect: async (_c, key): Promise<CommandOutcome> => {
      stored.push(key);
      return {
        text: "connected FreeLLMAPI gateway (self-hosted)",
        json: { ok: true },
        exitCode: 0,
      };
    },
    ...over,
  };
  return { d, engine, terminal, stored };
}

test("connect hands the gateway key to the verified keychain path — and never prints it", async () => {
  const { d, engine, stored } = deps({ envelope: { command: "freellmapi", ok: true, key: KEY } });
  const out = await runFreellmapiCommand(ctx("connect"), d);
  assert.deepEqual(engine, [["freellmapi", "key"]]);
  assert.deepEqual(stored, [KEY]);
  assert.equal(out.exitCode, 0);
  assert.ok(!JSON.stringify(out).includes(KEY), "the key leaked into the outcome");
  assert.match(out.text ?? "", /\/models → FreeLLMAPI → auto/);
});

test("connect with no key yet stores nothing and says what to run", async () => {
  const { d, stored } = deps({
    envelope: { command: "freellmapi", ok: false, key: "", error: "no gateway key yet" },
  });
  const out = await runFreellmapiCommand(ctx("connect"), d);
  assert.equal(out.exitCode, 2);
  assert.deepEqual(stored, []);
  assert.match(out.text ?? "", /freellmapi setup/);
});

test("a one-shot run at a terminal hands the engine the terminal, globals first", async () => {
  const { d, terminal, engine } = deps({ interactive: true });
  const out = await runFreellmapiCommand(ctx("setup", { ref: "v1.2.3" }, true), d);
  assert.deepEqual(terminal, [["--yes", "freellmapi", "setup", "--ref", "v1.2.3"]]);
  assert.deepEqual(engine, []);
  assert.equal(out.exitCode, 0);
});

test("inside a session the refusal is RENDERED, with every critical advisory", async () => {
  const refusal: EngineEnvelope = {
    command: "freellmapi",
    action: "setup",
    ok: false,
    stage: "gate",
    error: "8 CRITICAL finding(s) — the release is not safe to install",
    gate: {
      verdict: "block",
      why: "8 CRITICAL finding(s) — the release is not safe to install",
      critical: ["zod@3.25.76 CVE-2023-54404 (CRITICAL) fixed:4.6.6 — package-lock.json"],
      high: ["vite@8.2.2 CVE-2026-112942 (HIGH) fixed:8.2.4"],
    },
  };
  const { d, terminal, engine } = deps({ interactive: false, envelope: refusal });
  const out = await runFreellmapiCommand(ctx("setup"), d);
  assert.deepEqual(terminal, [], "a session must never hand its terminal to a child");
  assert.deepEqual(engine, [["freellmapi", "setup"]]);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /nemesis BLOCK/);
  assert.match(out.text ?? "", /CRITICAL zod@3\.25\.76 CVE-2023-54404/);
  assert.match(out.text ?? "", /HIGH vite@8\.2\.2/);
});

test("a stray key in any other envelope is scrubbed before it can be shown", async () => {
  const { d } = deps({ envelope: { command: "freellmapi", ok: true, key: KEY } });
  const out = await runFreellmapiCommand(ctx("status"), d);
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test("an unknown verb is a typo (exit 1), and `key` is not a user verb", async () => {
  for (const sub of ["force-install", "key"]) {
    const { d, engine } = deps();
    const out = await runFreellmapiCommand(ctx(sub), d);
    assert.equal(out.exitCode, 1, sub);
    assert.deepEqual(engine, [], sub);
  }
});
