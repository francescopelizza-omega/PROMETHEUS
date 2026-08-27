/**
 * diagram-cmd.test.ts — `prometheus diagram uml|deps` with an injected fake runSidecar
 * (no real python spawn). Covers verb routing, exit codes, --json passthrough,
 * --out write (+ .md fence + overwrite guard), --summary, and the path guard (CLI-008).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CliContext } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import { runDiagram } from "./diagram-cmd.js";
import type { SidecarDeps } from "./sidecar-cmd.js";

setColorEnabled(false);

function makeCtx(
  command: string[],
  positionals: string[] = [],
  flags: Record<string, string | true> = {},
  json = false,
  unmatchedSub?: string,
): CliContext {
  const force = flags.force === true;
  return {
    client: undefined as unknown as CliContext["client"],
    json,
    args: { command, positionals, flags, json, force, unmatchedSub } as unknown as ParsedArgs,
  };
}

const UML_ENV = {
  ok: true,
  command: "uml",
  path: "/fix",
  classCount: 1,
  mermaid: "classDiagram\n  Foo : +bar()",
  dot: 'digraph UML {\n  "Foo";\n}',
};
const DEPS_ENV = {
  ok: true,
  command: "deps",
  path: "/fix",
  moduleCount: 2,
  mermaid: 'graph LR\n  n_mod_a["mod_a"] --> n_mod_b["mod_b"]',
  dot: 'digraph deps {\n  "mod_a" -> "mod_b";\n}',
  cycles: [],
};

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

test("uml: renders mermaid starting with the header + a summary count", async () => {
  const { deps, calls } = fakeDeps(UML_ENV);
  const out = await runDiagram(makeCtx(["diagram", "uml"], ["/fix"]), deps);
  assert.equal(out.exitCode, 0);
  assert.ok((out.text ?? "").startsWith("classDiagram"), "mermaid header is byte-one");
  assert.match(out.text ?? "", /Foo/);
  assert.match(out.text ?? "", /1 classes/);
  assert.deepEqual(calls[0]?.argv, ["uml", "--path", "/fix"]);
});

test("deps: renders the import edge", async () => {
  const { deps } = fakeDeps(DEPS_ENV);
  const out = await runDiagram(makeCtx(["diagram", "deps"], ["/fix"]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /mod_a.*-->.*mod_b/s);
  assert.match(out.text ?? "", /2 modules/);
});

test("--json emits the raw envelope", async () => {
  const { deps } = fakeDeps(UML_ENV);
  const out = await runDiagram(makeCtx(["diagram", "uml"], ["/fix"], {}, true), deps);
  assert.deepEqual(out.json, UML_ENV);
  assert.equal(out.exitCode, 0);
});

test("unknown verb → exit 1 listing valid verbs", async () => {
  const { deps, calls } = fakeDeps(UML_ENV);
  const out = await runDiagram(makeCtx(["diagram"], []), deps);
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /uml, deps/);
  assert.equal(calls.length, 0);
});

test("a typo'd verb names the ACTUAL typo, not '(none)' — regression for unmatchedSub", async () => {
  // command[1] is undefined for a TWO_WORD mismatch (parse.ts sets `unmatchedSub` instead),
  // so this used to render "unknown verb (none)" instead of naming the typo.
  const { deps, calls } = fakeDeps(UML_ENV);
  const out = await runDiagram(makeCtx(["diagram"], [], {}, false, "umll"), deps);
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /unknown verb "umll"/);
  assert.equal(calls.length, 0);
});

test("option-shaped path is refused before the sidecar", async () => {
  const { deps, calls } = fakeDeps(UML_ENV);
  const out = await runDiagram(makeCtx(["diagram", "uml"], ["--help"]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal(calls.length, 0);
});

test("sidecar failure (nonexistent path) → exit 2", async () => {
  const { deps } = fakeDeps({ ok: false, command: "uml", error: "not a directory: /nope" });
  const out = await runDiagram(makeCtx(["diagram", "uml"], ["/nope"]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /not a directory/);
});

test("--out writes the artifact; .md wraps in a mermaid fence; overwrite guarded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-diag-out-"));
  const mmd = join(dir, "d.mmd");
  const md = join(dir, "d.md");
  const { deps } = fakeDeps(UML_ENV);

  const raw = await runDiagram(makeCtx(["diagram", "uml"], ["/fix"], { out: mmd }), deps);
  assert.equal(raw.exitCode, 0);
  assert.match(raw.text ?? "", /wrote uml diagram/);
  assert.ok(readFileSync(mmd, "utf8").startsWith("classDiagram"), ".mmd is raw mermaid");

  const fenced = await runDiagram(makeCtx(["diagram", "uml"], ["/fix"], { out: md }), deps);
  assert.equal(fenced.exitCode, 0);
  assert.match(readFileSync(md, "utf8"), /^```mermaid\n/);

  // existing file without --force → refused (exit 2, no silent overwrite)
  writeFileSync(mmd, "OLD");
  const refused = await runDiagram(makeCtx(["diagram", "uml"], ["/fix"], { out: mmd }), deps);
  assert.equal(refused.exitCode, 2);
  assert.equal(readFileSync(mmd, "utf8"), "OLD", "must not overwrite without --force");
  // with --force → overwrites
  const forced = await runDiagram(
    makeCtx(["diagram", "uml"], ["/fix"], { out: mmd, force: true }),
    deps,
  );
  assert.equal(forced.exitCode, 0);
  assert.ok(readFileSync(mmd, "utf8").startsWith("classDiagram"));
});

test("--summary renders a terse pane view", async () => {
  const { deps } = fakeDeps(UML_ENV);
  const out = await runDiagram(makeCtx(["diagram", "uml"], ["/fix"], { summary: true }), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /diagram uml/);
  assert.match(out.text ?? "", /1 classes/);
  assert.match(out.text ?? "", /use --out/);
});

test("--json --out WRITES the file: the format decides how to report, never whether it happens", async () => {
  // regression: the `--json` early return sat ABOVE the --out block, so
  // `--json diagram deps <path> --out f.md` wrote nothing and still reported ok:true, while
  // the identical command without --json wrote the file. Measured against the built binary.
  const dir = mkdtempSync(join(tmpdir(), "prom-diagram-json-"));
  const target = join(dir, "graph.md");
  const { deps } = fakeDeps(DEPS_ENV);
  const out = await runDiagram(makeCtx(["diagram", "deps"], ["/fix"], { out: target }, true), deps);
  assert.equal(out.exitCode, 0);
  const body = readFileSync(target, "utf8");
  assert.match(body, /^```mermaid\n/, "a .md target is still fenced under --json");
  assert.match(body, /graph LR/);
  const json = out.json as { ok?: boolean; out?: string; written?: boolean };
  assert.equal(json.written, true, "the envelope must say the artifact was written");
  assert.equal(json.out, target);
});

test("--json without --out still returns the sidecar envelope untouched", async () => {
  const { deps } = fakeDeps(DEPS_ENV);
  const out = await runDiagram(makeCtx(["diagram", "deps"], ["/fix"], {}, true), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.json, DEPS_ENV);
});

test("--json --out still refuses to clobber an existing file without --force", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-diagram-clobber-"));
  const target = join(dir, "graph.md");
  writeFileSync(target, "PRECIOUS", "utf8");
  const { deps } = fakeDeps(DEPS_ENV);
  const out = await runDiagram(makeCtx(["diagram", "deps"], ["/fix"], { out: target }, true), deps);
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error?: string }).error, "exists");
  assert.equal(readFileSync(target, "utf8"), "PRECIOUS");
});
