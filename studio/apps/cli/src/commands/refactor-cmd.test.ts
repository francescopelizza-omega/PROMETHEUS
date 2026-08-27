/**
 * refactor-cmd.test.ts — `prometheus refactor structure|imports|callgraph` with an
 * injected fake runSidecar (no real python spawn): verb routing, rendering, exit
 * codes, --json passthrough, and the pre-spawn verb/path guards (CLI-009).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CliContext } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import { runRefactor } from "./refactor-cmd.js";
import type { SidecarDeps } from "./sidecar-cmd.js";

setColorEnabled(false);

function makeCtx(
  command: string[],
  positionals: string[] = [],
  json = false,
  unmatchedSub?: string,
): CliContext {
  return {
    client: undefined as unknown as CliContext["client"],
    json,
    args: { command, positionals, flags: {}, json, unmatchedSub } as unknown as ParsedArgs,
  };
}

function fakeDeps(env: Record<string, unknown>): {
  deps: SidecarDeps;
  calls: { script: string; argv: string[] }[];
} {
  const calls: { script: string; argv: string[] }[] = [];
  const deps: SidecarDeps = {
    runSidecar: (async (script: string, argv: string[]) => {
      calls.push({ script, argv });
      return env;
    }) as SidecarDeps["runSidecar"],
  };
  return { deps, calls };
}

test("structure: renders classes/functions with line numbers", async () => {
  const { deps, calls } = fakeDeps({
    ok: true,
    command: "structure",
    file: "m.py",
    structure: [
      { kind: "function", name: "helper", line: 3, args: [] },
      { kind: "function", name: "main", line: 6, args: [] },
      {
        kind: "class",
        name: "A",
        line: 9,
        bases: [],
        members: [{ kind: "function", name: "m", line: 10, args: ["self"] }],
      },
    ],
  });
  const out = await runRefactor(makeCtx(["refactor", "structure"], ["m.py"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /def helper\(\) :3/);
  assert.match(out.text ?? "", /def main\(\) :6/);
  assert.match(out.text ?? "", /class A :9/);
  assert.match(out.text ?? "", /def m\(self\) :10/);
  assert.deepEqual(calls[0]?.argv, ["structure", "--file", "m.py"]);
});

test("imports: renders the import list", async () => {
  const { deps } = fakeDeps({
    ok: true,
    command: "imports",
    imports: [
      { module: "os", as: null, line: 1 },
      { module: "typing", name: "List", as: null, line: 2 },
    ],
  });
  const out = await runRefactor(makeCtx(["refactor", "imports"], ["m.py"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /import os/);
  assert.match(out.text ?? "", /from typing import List/);
});

test("callgraph: groups edges by caller (no phantom expansion)", async () => {
  const { deps } = fakeDeps({
    ok: true,
    command: "callgraph",
    edges: [{ from: "main", to: "helper" }],
  });
  const out = await runRefactor(makeCtx(["refactor", "callgraph"], ["m.py"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /main.*→.*helper/s);
  assert.match(out.text ?? "", /1 edges/);
});

test("--json emits the raw envelope", async () => {
  const env = { ok: true, command: "structure", file: "m.py", structure: [] };
  const { deps } = fakeDeps(env);
  const out = await runRefactor(makeCtx(["refactor", "structure"], ["m.py"], true), deps);
  assert.deepEqual(out.json, env);
  assert.equal(out.exitCode, 0);
});

test("unknown verb → exit 1 listing valid verbs (no spawn)", async () => {
  const { deps, calls } = fakeDeps({ ok: true, command: "x" });
  const out = await runRefactor(makeCtx(["refactor"], ["m.py"]), deps);
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /structure, imports, callgraph/);
  assert.equal(calls.length, 0);
});

test("a typo'd verb names the ACTUAL typo, not '(none)' — regression for unmatchedSub", async () => {
  // command[1] is undefined for a TWO_WORD mismatch (parse.ts sets `unmatchedSub` instead),
  // so this used to render "unknown verb (none)" instead of naming the typo.
  const { deps, calls } = fakeDeps({ ok: true, command: "x" });
  const out = await runRefactor(makeCtx(["refactor"], ["m.py"], false, "structur"), deps);
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /unknown verb "structur"/);
  assert.equal(calls.length, 0);
});

test("option-shaped path refused before the sidecar", async () => {
  const { deps, calls } = fakeDeps({ ok: true, command: "structure" });
  const out = await runRefactor(makeCtx(["refactor", "structure"], ["--help"]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal(calls.length, 0);
});

test("sidecar failure (bad file) → exit 2", async () => {
  const { deps } = fakeDeps({ ok: false, command: "structure", error: "FileNotFoundError: nope" });
  const out = await runRefactor(makeCtx(["refactor", "structure"], ["nope.py"]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /failed/);
});
