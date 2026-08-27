/**
 * artifact.test.ts — the published table must not drift from the authored one.
 *
 * `prometheus.py` cannot import `rules.ts`, so the builtin table is PUBLISHED to
 * `studio/config/effort-capabilities.builtin.json` and Python reads that. The whole
 * justification for a generated artifact rather than a second hand-maintained table is that
 * generation cannot drift — but only if something checks. Without this test, a rule added in
 * TypeScript and never re-emitted leaves Python resolving against a stale table, silently, and
 * the two surfaces disagree about what `/think high` means on the same model.
 *
 * Regenerate with: node studio/scripts/emit-effort-rules.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { builtinRules } from "./rules.js";

/** studio/ — four levels up from packages/core/src/ai/effort/. */
const STUDIO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const ARTIFACT = join(STUDIO, "config", "effort-capabilities.builtin.json");

test("the published builtin table exists — Python has no fallback of its own", () => {
  assert.ok(
    existsSync(ARTIFACT),
    "config/effort-capabilities.builtin.json is missing — run `node studio/scripts/emit-effort-rules.mjs`",
  );
});

test("the published table matches `builtinRules()` exactly", () => {
  // Deep-equal on the parsed JSON rather than a string compare: formatting is the generator's
  // business, the RULES are the contract. A mismatch here means someone edited rules.ts and
  // did not re-emit — so `prometheus --effort` is answering from a stale table.
  const published = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    version: number;
    rules: unknown[];
  };
  assert.equal(published.version, 1);
  assert.deepEqual(
    published.rules,
    JSON.parse(JSON.stringify(builtinRules())),
    "the published table has drifted — run `node studio/scripts/emit-effort-rules.mjs`",
  );
});

test("every published rule carries its provenance across the boundary", () => {
  // The evidence level is the most important thing a non-TypeScript consumer cannot re-derive:
  // two thirds of this table is inferred rather than measured, and a Python caller deserves to
  // know that as much as a TypeScript one.
  const published = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    rules: Array<{ id: string; provenance?: string }>;
  };
  const missing = published.rules.filter((r) => r.provenance === undefined).map((r) => r.id);
  assert.deepEqual(missing, []);
});

test("the published table is STAGED for packaging, at the path the engine looks in", () => {
  /**
   * The artifact reaching Python in a checkout is not the same thing as it reaching Python in a
   * SHIPPED build. `scripts/stage-engine.mjs` copies the engine into `staging/engine/`, which
   * electron-builder ships as `<Resources>/engine/`, and it used to copy `prometheus.py` and
   * `nemesis` and nothing else — while `prometheus.py` resolves this table RELATIVE TO ITS OWN
   * PATH. So every packaged build read an empty table and `--effort` answered "no reasoning
   * control" for every model on earth, with the same command working perfectly from source.
   *
   * Both halves are asserted against ONE literal below, which is the whole point: the failure
   * was never that either side was wrong alone, it was that they disagreed. Changing the layout
   * on one side and not the other fails here rather than in a shipped build nobody re-tests.
   */
  const engine = readFileSync(join(STUDIO, "..", "prometheus.py"), "utf8");
  const stager = readFileSync(join(STUDIO, "scripts", "stage-engine.mjs"), "utf8");
  assert.ok(
    engine.includes('"studio" / "config" / "effort-capabilities.builtin.json"'),
    "prometheus.py no longer resolves the table at studio/config/ — update stage-engine.mjs too",
  );
  assert.ok(
    stager.includes('join(out, "studio", "config", "effort-capabilities.builtin.json")'),
    "stage-engine.mjs does not stage the table where prometheus.py looks for it — a packaged " +
      "build would resolve an EMPTY effort table",
  );
});
