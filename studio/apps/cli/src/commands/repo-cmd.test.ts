/**
 * repo-cmd.test.ts — the `prom repo …` surface over repo.py: the gated clone
 * (preview→execute, NO --confirm toggle), list/pin/branch argv, and reads. FAKE
 * runSidecar; no python spawn, no network.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { runRepoCommand } from "./repo-cmd.js";
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

test("repo add: PREVIEW by default — no spawn, plan has NO --confirm", async () => {
  const { deps, calls } = fake();
  const out = await runRepoCommand(ctxFor(["repo", "add", "https://github.com/a/b"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status: string }).status, "preview");
  assert.deepEqual((out.json as { argv: string[] }).argv, [
    "clone",
    "--url",
    "https://github.com/a/b",
  ]);
  assert.deepEqual(calls, []);
});

test("repo add --yes --branch: EXECUTES the gated clone with the branch flag", async () => {
  const { deps, calls } = fake({ ok: true, blocked: false });
  await runRepoCommand(ctxFor(["repo", "add", "https://x.git", "--branch", "dev", "--yes"]), deps);
  assert.deepEqual(calls[0], {
    script: "repo.py",
    argv: ["clone", "--url", "https://x.git", "--branch", "dev"],
  });
});

test("repo pin --yes → pin --id --sha", async () => {
  const { deps, calls } = fake();
  await runRepoCommand(ctxFor(["repo", "pin", "myrepo", "abc123", "--yes"]), deps);
  assert.deepEqual(calls[0]?.argv, ["pin", "--id", "myrepo", "--sha", "abc123"]);
});

test("repo list: READ renders the index (exit 0)", async () => {
  const { deps, calls } = fake({ ok: true, repos: [{ id: "r1", status: "promoted", url: "u" }] });
  const out = await runRepoCommand(ctxFor(["repo", "list"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["list"]);
  assert.match(out.text ?? "", /r1/);
});

test("repo pin with a missing sha → usage error (exit 2)", async () => {
  const { deps, calls } = fake();
  const out = await runRepoCommand(ctxFor(["repo", "pin", "myrepo"]), deps);
  assert.equal(out.exitCode, 2);
  assert.deepEqual(calls, []);
});
