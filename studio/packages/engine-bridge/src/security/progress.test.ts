/**
 * progress.test.ts — the nemesis stderr → scan-stage parser (CLI-040). Pure, no subprocess.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SCAN_STAGE_COUNT, parseStageLine } from "./progress.js";

test("parseStageLine: known nemesis wordings map to ordered stages", () => {
  assert.equal(parseStageLine("fetching github.com/foo/bar …").stage, "resolve");
  assert.equal(parseStageLine("scanning snapshot of repo").stage, "resolve"); // snapshot ⇒ resolve
  assert.equal(parseStageLine("applying static rules").stage, "static");
  assert.equal(parseStageLine("matching secret patterns").stage, "static");
  assert.equal(parseStageLine("checking threat feeds / IOC db").stage, "threatdb");
  assert.equal(parseStageLine("computing risk score → verdict").stage, "verdict");
  // indexes are 1-based over the 4 ordered stages.
  assert.equal(parseStageLine("fetching x").index, 1);
  assert.equal(parseStageLine("static rules").index, 2);
  assert.equal(parseStageLine("threat feed").index, 3);
  assert.equal(parseStageLine("verdict ready").index, 4);
  assert.equal(SCAN_STAGE_COUNT, 4);
});

test("parseStageLine: an unknown/garbage line degrades to the generic 'scan' stage (never throws)", () => {
  const g = parseStageLine("\x1b[2mzork blorp 42\x1b[0m");
  assert.equal(g.stage, "scan");
  assert.equal(g.index, 0); // 0 ⇒ not one of the numbered stages
  assert.equal(g.detail, "zork blorp 42"); // ANSI stripped, trimmed
  // empty / whitespace never throws
  assert.equal(parseStageLine("").stage, "scan");
  assert.equal(parseStageLine("   ").detail, "");
});
