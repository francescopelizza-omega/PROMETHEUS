/**
 * env-cmd.test.ts — the `prometheus env …` sidecar surface: preview→execute, the exact
 * sidecar argv per verb, the never-force gate, and usage errors. Deterministic: a
 * FAKE runSidecar (records argv, never spawns python) is injected as deps.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { runEnvCommand } from "./env-cmd.js";
import type { SidecarDeps } from "./sidecar-cmd.js";

function fake(reply: Record<string, unknown> = { ok: true, command: "x" }): {
  deps: SidecarDeps;
  calls: { script: string; argv: string[] }[];
} {
  const calls: { script: string; argv: string[] }[] = [];
  const runSidecar = (async (script: string, argv: string[]) => {
    calls.push({ script, argv });
    return { ok: true, command: "x", ...reply };
  }) as unknown as SidecarDeps["runSidecar"];
  return { deps: { runSidecar }, calls };
}

const ctxFor = (argv: string[]) => makeContext(parseArgs(argv));

test("prometheus env <typo>: reports unknown env verb, never silently defaults to list", async () => {
  // regression: command[1] is undefined for a TWO_WORD mismatch (parse.ts sets `unmatchedSub`
  // instead), so a typo used to silently fall through to the "list" branch.
  const { deps } = fake();
  const out = await runEnvCommand(ctxFor(["env", "xyz", "myenv", "--json"]), deps);
  assert.equal(out.exitCode, 1);
  assert.equal((out.json as { error: string }).error, "unknown-verb");
});

test("prometheus env init: not a real verb (only `create` makes a new env) — unknown-verb, not silently accepted", async () => {
  const { deps } = fake();
  const out = await runEnvCommand(ctxFor(["env", "init", "myenv", "--json"]), deps);
  assert.equal(out.exitCode, 1);
  assert.equal((out.json as { error: string }).error, "unknown-verb");
});

test("env templates: READ runs template.list + renders the recipes", async () => {
  const { deps, calls } = fake({
    ok: true,
    templates: [{ id: "llm-cpu", label: "LLM (CPU)", python: "3.11", packages: ["a", "b"] }],
  });
  const out = await runEnvCommand(ctxFor(["env", "templates"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["template.list"]);
  assert.match(out.text ?? "", /llm-cpu/);
});

test("env template <id> --env: PREVIEW by default (template.commit plan, no spawn)", async () => {
  const { deps, calls } = fake();
  const out = await runEnvCommand(ctxFor(["env", "template", "llm-cpu", "--env", "ml"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status: string }).status, "preview");
  assert.deepEqual((out.json as { argv: string[] }).argv, [
    "template.commit",
    "--template",
    "llm-cpu",
    "--env",
    "ml",
    "--confirm",
  ]);
  assert.deepEqual(calls, []);
});

test("env create --template --yes: CHAINS env.create then template.commit", async () => {
  const { deps, calls } = fake();
  const out = await runEnvCommand(
    ctxFor(["env", "create", "ml", "--template", "llm-cpu", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.argv[0], "env.create");
  assert.deepEqual(calls[1]?.argv.slice(0, 5), [
    "template.commit",
    "--template",
    "llm-cpu",
    "--env",
    "ml",
  ]);
});

test("env create: PREVIEW by default (no spawn), plan carries --confirm", async () => {
  const { deps, calls } = fake();
  const out = await runEnvCommand(ctxFor(["env", "create", "foo"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status: string }).status, "preview");
  assert.deepEqual((out.json as { argv: string[] }).argv, ["env.create", "foo", "--confirm"]);
  assert.deepEqual(calls, []); // NOTHING ran
});

test("env create --yes: EXECUTES with the exact envmgr argv", async () => {
  const { deps, calls } = fake();
  const out = await runEnvCommand(
    ctxFor(["env", "create", "foo", "--python", "3.11", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    script: "envmgr.py",
    argv: ["env.create", "foo", "--python", "3.11", "--confirm"],
  });
});

test("env add --yes → pkg.install with the spec list", async () => {
  const { deps, calls } = fake();
  await runEnvCommand(ctxFor(["env", "add", "myenv", "numpy", "scipy", "--yes"]), deps);
  assert.deepEqual(calls[0]?.argv, ["pkg.install", "myenv", "numpy", "scipy", "--confirm"]);
});

test("env cuda torch --yes → cuda.torch --env (three-level positional dispatch)", async () => {
  const { deps, calls } = fake();
  await runEnvCommand(ctxFor(["env", "cuda", "torch", "myenv", "--yes"]), deps);
  assert.deepEqual(calls[0]?.argv, ["cuda.torch", "--env", "myenv", "--confirm"]);
});

test("env clone --force adds --force AND --confirm (override + execute)", async () => {
  const { deps, calls } = fake();
  await runEnvCommand(ctxFor(["env", "clone", "a", "b", "--force"]), deps);
  assert.deepEqual(calls[0]?.argv, ["env.clone", "a", "b", "--confirm", "--force"]);
});

test("env doctor: READ runs straight + renders (exit 0)", async () => {
  const { deps, calls } = fake({ ok: true, health: "ok", checks: { pip: "23.0" } });
  const out = await runEnvCommand(ctxFor(["env", "doctor", "myenv"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["env.doctor", "myenv"]);
  assert.match(out.text ?? "", /health/);
});

test("never-force: --force under the ci profile is HARD-blocked (exit 2, no spawn)", async () => {
  const prev = process.env.PROM_ALLOW_FORCE;
  // biome-ignore lint/performance/noDelete: ensure the override is truly unset
  delete process.env.PROM_ALLOW_FORCE;
  try {
    const { deps, calls } = fake();
    const out = await runEnvCommand(
      ctxFor(["--profile", "ci", "--force", "env", "create", "foo"]),
      deps,
    );
    assert.equal(out.exitCode, 2);
    assert.equal((out.json as { error: string }).error, "force-blocked");
    assert.deepEqual(calls, []);
  } finally {
    if (prev !== undefined) process.env.PROM_ALLOW_FORCE = prev;
  }
});

test("env create with NO name → usage error (exit 1), never a silent 0", async () => {
  const { deps, calls } = fake();
  const out = await runEnvCommand(ctxFor(["env", "create"]), deps);
  assert.equal(out.exitCode, 1);
  assert.equal((out.json as { error: string }).error, "missing-argument");
  assert.deepEqual(calls, []);
});

test("env init (recognized but unhandled) → exit 1 with a verb hint", async () => {
  const { deps } = fake();
  const out = await runEnvCommand(ctxFor(["env", "init"]), deps);
  assert.equal(out.exitCode, 1);
});

test("--dry-run outranks --yes: a preview NEVER spawns the sidecar with --confirm", async () => {
  // regression: `--dry-run` is a declared global boolean, documented in --help and forwarded
  // to the engine for registry-routed verbs, but `wantsExecute()` only looked at --yes/--force.
  // `prometheus --dry-run --yes env delete <name>` really removed the environment on disk and
  // reported `executed: true` — measured against the built binary, the venv was gone.
  for (const verb of ["delete", "create"]) {
    const { deps, calls } = fake();
    const out = await runEnvCommand(
      ctxFor(["env", verb, "probe", "--dry-run", "--yes", "--json"]),
      deps,
    );
    assert.equal(
      calls.length,
      0,
      `env ${verb} --dry-run spawned the sidecar: ${JSON.stringify(calls)}`,
    );
    assert.equal((out.json as { status?: string }).status, "preview");
    assert.equal(out.exitCode, 0);
  }
});

test("--dry-run outranks --force too (force must not smuggle the mutation past the preview)", async () => {
  const { deps, calls } = fake();
  const out = await runEnvCommand(
    ctxFor(["env", "delete", "probe", "--dry-run", "--force", "--json"]),
    deps,
  );
  assert.equal(calls.length, 0);
  assert.equal((out.json as { status?: string }).status, "preview");
});

test("without --dry-run, --yes still executes: the preview fix does not disarm the real verb", async () => {
  const { deps, calls } = fake();
  await runEnvCommand(ctxFor(["env", "delete", "probe", "--yes", "--json"]), deps);
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0]!.argv.includes("--confirm"),
    `expected --confirm, got ${calls[0]!.argv.join(" ")}`,
  );
});
