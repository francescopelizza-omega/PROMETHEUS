/**
 * generic.test.ts — the §2 verb path's RENDERING, which had no coverage and printed one word.
 *
 * Two defects lived here, both invisible to every other suite because nothing executed this
 * module's human branch:
 *
 *   1. `runEngineSub` built its text from `summarize()` — the one-line `"<cmd>: ok"` toast —
 *      and never called `renderEnvelope`. `commands/route.ts` had already fixed exactly this for
 *      the registry path AND left a comment saying so; this second engine entry point kept the
 *      old behaviour, so `prometheus plugin list` printed `plugin list: ok` and `skill list`
 *      printed `skill list: ok`, with the whole catalog thrown away underneath.
 *   2. `renderRaw` printed its lines verbatim. Those reads run WITH `--json`, and
 *      `localai models` / `localai audit` answer with a v1 envelope (`models[]` / `tools[]`,
 *      no `lines[]`) — so the "line" was the entire serialized envelope and the user got a
 *      screenful of raw JSON where every sibling verb prints a table.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { RawEngineResult } from "@prometheus/engine-bridge";

import type { CliContext } from "../context.js";
import { setColorEnabled } from "../render.js";
import { renderRaw } from "./generic.js";

setColorEnabled(false);

const CTX = { json: false } as unknown as CliContext;
const raw = (lines: string[]): RawEngineResult => ({
  ok: true,
  command: "localai",
  action: "models",
  lines,
  raw: lines.join("\n"),
});

test("renderRaw: a JSON envelope with no `lines[]` is RENDERED, not dumped at the user", () => {
  const envelope = JSON.stringify({
    command: "localai",
    ok: true,
    action: "models",
    models: [
      { id: "qwen3", name: "Qwen3", local: "yes" },
      { id: "gpt-oss", name: "gpt-oss", local: "yes" },
    ],
  });
  const out = renderRaw(CTX, raw([envelope])).text ?? "";
  assert.ok(!out.includes('{"command"'), "the raw envelope must never reach the terminal");
  assert.match(out, /models \(2\)/);
  assert.match(out, /qwen3/);
});

test("renderRaw: a genuine human table is still printed verbatim", () => {
  const out = renderRaw(CTX, raw(["  [world-sim] mirofish — MiroFish", "      blurb"])).text ?? "";
  assert.match(out, /mirofish/);
  assert.match(out, /blurb/);
});

test("renderRaw: text that merely BEGINS with a brace is not mistaken for an envelope", () => {
  const out = renderRaw(CTX, raw(["{not json at all", "second line"])).text ?? "";
  assert.match(out, /\{not json at all/);
  assert.match(out, /second line/);
});

test("renderRaw: --json is untouched — the machine channel keeps the raw lines", () => {
  const jsonCtx = { json: true } as unknown as CliContext;
  const out = renderRaw(jsonCtx, raw(['{"command":"localai","models":[]}']));
  assert.equal(out.text, undefined);
  assert.deepEqual((out.json as { lines: string[] }).lines, ['{"command":"localai","models":[]}']);
});

test("the engine-subcommand path renders the ENVELOPE, not just the one-line toast", () => {
  /**
   * `runEngineSub`'s human branch is not reachable without spawning the engine, so this asserts
   * the shape of the code instead: it must consult `renderEnvelope` and keep `summarize` only as
   * the fallback. The distinction is the entire defect — the two calls are one character apart in
   * a diff and a whole command surface apart for the user.
   */
  const src = readFileSync(new URL("./generic.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /renderEnvelope\(label, env\) \?\? summarize\(label, env\)/,
    "generic.ts must render the envelope and fall back to the toast, not print the toast alone",
  );
});
