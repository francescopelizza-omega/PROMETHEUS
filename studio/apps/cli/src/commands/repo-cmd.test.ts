/**
 * repo-cmd.test.ts — the `prometheus repo …` surface over repo.py: the gated clone
 * (preview→execute, NO --confirm toggle), list/pin/branch argv, and reads. FAKE
 * runSidecar; no python spawn, no network.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import { renderRescan, runRepoCommand } from "./repo-cmd.js";
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

test("repo pin with a missing sha → usage error (exit 1)", async () => {
  const { deps, calls } = fake();
  const out = await runRepoCommand(ctxFor(["repo", "pin", "myrepo"]), deps);
  assert.equal(out.exitCode, 1);
  assert.deepEqual(calls, []);
});

/**
 * Regression: a mistyped repo sub-verb used to be silently swallowed and fall through to "list",
 * discarding the user's real action + arguments with exit 0 and no error — the switch's own
 * "unknown repo verb" branch was unreachable dead code. Fixed via parse.ts's `unmatchedSub`.
 */
test("a mistyped repo sub-verb reports 'unknown repo verb' instead of silently listing", async () => {
  const { deps, calls } = fake();
  const out = await runRepoCommand(ctxFor(["repo", "removee", "myid"]), deps);
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /unknown repo verb/);
  assert.match(out.text ?? "", /removee/);
  assert.deepEqual(calls, []); // never silently ran `list` (or anything else) against the sidecar
});

test("a genuinely bare /repo (no sub-verb at all) still defaults to list, unaffected", async () => {
  const { deps, calls } = fake({ ok: true, repos: [] });
  const out = await runRepoCommand(ctxFor(["repo"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls[0]?.argv, ["list"]);
});

test("rescan's --json envelope mirrors the verdict tier, not just the exit code", () => {
  /**
   * `renderRescan` mapped the nemesis tier to an exit code but returned no `json`, so the caller
   * fell back to the engine's raw envelope — which `_envelope.emit()` stamps `"ok": true` for any
   * scan that COMPLETED. A repo whose live tree now scans BLOCK therefore came back as
   * `{"ok": true}` while the process exited 20, and a CI script branching on `.ok` — the
   * documented envelope contract — treated it as clean. Only a script that happened to read `$?`
   * or `.verdict` caught it.
   *
   * `ok = allow` is the rule `prometheus gate` already uses: `ok` answers "is this safe to use",
   * not "did the scan run".
   */
  for (const [verdict, expectOk, expectExit] of [
    ["allow", true, 0],
    ["warn", false, 10],
    ["block", false, 20],
    ["deny", false, 20],
    ["error", false, 2],
  ] as const) {
    const out = renderRescan("acme/repo", { verdict, risk_score: 1, findings: [] });
    const json = out.json as { ok?: boolean; verdict?: string } | undefined;
    assert.equal(json?.ok, expectOk, `${verdict}: ok should be ${expectOk}`);
    assert.equal(json?.verdict, verdict, `${verdict}: the tier must survive into the envelope`);
    assert.equal(out.exitCode, expectExit, `${verdict}: exit code`);
  }
});
