/**
 * tool-runner.test.ts — `grep`'s pattern comes from the MODEL, so its cost must be bounded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type MakeGrepWorker, createVsCodeToolRunner } from "./tool-runner.js";
import type { WorkspaceIo } from "./workspace-io.js";

/** An in-memory workspace — no vscode, no disk. */
function io(files: Record<string, string>): WorkspaceIo {
  return {
    root: "/ws",
    async findFiles(_glob: string, maxResults: number) {
      // the real `findFiles` CAPS its result — that cap is what the truncation test exercises
      return Object.keys(files).sort().slice(0, maxResults);
    },
    async readFile(p: string) {
      const t = files[p];
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
  } as unknown as WorkspaceIo;
}

/** A worker seam that never answers — exactly what a catastrophic regex looks like. */
const wedgedWorker: MakeGrepWorker = () => ({
  async match(_file, _text, budgetMs) {
    await new Promise((r) => setTimeout(r, budgetMs + 5));
    return null; // the real worker is terminated and reports the same way
  },
  async dispose() {},
});

/** A worker seam that matches promptly, for the control case. */
const fastWorker: MakeGrepWorker = (pattern, flags) => {
  const re = new RegExp(pattern, flags);
  return {
    async match(file, text) {
      const out: string[] = [];
      text.split("\n").forEach((line, i) => {
        if (re.test(line)) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
      return out;
    },
    async dispose() {},
  };
};

test("a catastrophically-backtracking grep is STOPPED instead of freezing the host", async () => {
  /**
   * JavaScript's regex engine has no timeout. `(a+)+$` against a 61-character line did not
   * return in over five minutes — measured. Matching on the extension host's own thread
   * therefore froze the whole VS Code window: no confirm, no cancel, no way back, from a pattern
   * the MODEL chose. The matching now runs in a worker so it can be terminated.
   *
   * A timeout is reported as a FAILURE, never as "no matches" — those two answers would send the
   * model in opposite directions.
   */
  const run = createVsCodeToolRunner({
    io: io({ "big.txt": `${"a".repeat(60)}X\n` }),
    onToolNote: () => {},
    makeGrepWorker: wedgedWorker,
  });

  const started = Date.now();
  const out = await run({ name: "grep" } as never, { pattern: "(a+)+$", glob: "**/*" });
  const elapsed = Date.now() - started;

  assert.equal(out.ok, false, "a search that never finished was reported as success");
  assert.match(out.summary, /was stopped/);
  assert.match(out.summary, /nested quantifiers/);
  assert.doesNotMatch(out.summary, /no matches/, "a timeout must not read as an empty result");
  assert.ok(elapsed < 60_000, `the search was not bounded: ${elapsed}ms`);
});

test("an ordinary grep still finds its matches", async () => {
  // self-validating: the bound must not have turned grep into a tool that never returns hits.
  const run = createVsCodeToolRunner({
    io: io({ "a.ts": "const alpha = 1;\nconst beta = 2;\n", "b.ts": "alpha again\n" }),
    onToolNote: () => {},
    makeGrepWorker: fastWorker,
  });
  const out = await run({ name: "grep" } as never, { pattern: "alpha", glob: "**/*" });
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /a\.ts:1:/);
  assert.match(out.summary, /b\.ts:1:/);
});

test("an invalid regex is still rejected before any searching starts", async () => {
  const run = createVsCodeToolRunner({
    io: io({ "a.ts": "x\n" }),
    onToolNote: () => {},
    makeGrepWorker: fastWorker,
  });
  const out = await run({ name: "grep" } as never, { pattern: "(unclosed", glob: "**/*" });
  assert.equal(out.ok, false);
  assert.match(out.summary, /invalid regular expression/);
});

test("a TRUNCATED grep never reports 'no matches'", async () => {
  /**
   * `findFiles` is capped at MAX_GLOB_RESULTS candidates and the cap was silent, so in a
   * workspace with more files than that a symbol living past the cap produced
   * `{ok:true, "no matches for <pattern>"}` — which the model reads as "this symbol does not
   * exist anywhere". Measured: 601 files, the definition in the 601st, `no matches`.
   */
  const files: Record<string, string> = {};
  for (let i = 0; i < 600; i++)
    files[`filler_${String(i).padStart(4, "0")}.ts`] = "export const x = 1;\n";
  files["zzz_target.ts"] = "export function findMeUniqueSymbol() { return 42; }\n";

  const run = createVsCodeToolRunner({
    io: io(files),
    onToolNote: () => {},
    makeGrepWorker: fastWorker,
  });
  const out = await run({ name: "grep" } as never, { pattern: "findMeUniqueSymbol", glob: "**/*" });

  assert.equal(out.ok, true);
  assert.doesNotMatch(
    out.summary,
    /^no matches for findMeUniqueSymbol$/m,
    "a truncated search claimed the symbol does not exist",
  );
  assert.match(out.summary, /first \d+ files/);
  assert.match(out.summary, /NOT proof/, "the model must be told this is not a negative result");

  // self-validating: a search that really did cover everything still says so plainly.
  const small = createVsCodeToolRunner({
    io: io({ "a.ts": "const alpha = 1;\n" }),
    onToolNote: () => {},
    makeGrepWorker: fastWorker,
  });
  const miss = await small({ name: "grep" } as never, {
    pattern: "definitelyAbsent",
    glob: "**/*",
  });
  assert.match(miss.summary, /no matches for definitelyAbsent/);
  assert.doesNotMatch(miss.summary, /first \d+ files/);

  const hit = await small({ name: "grep" } as never, { pattern: "alpha", glob: "**/*" });
  assert.match(hit.summary, /a\.ts:1:/);
});
