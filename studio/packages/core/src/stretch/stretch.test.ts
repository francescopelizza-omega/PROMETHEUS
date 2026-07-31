import assert from "node:assert/strict";
/**
 * stretch.test.ts — the feasibility assessor + the AirLLM/offload escalation chain.
 */
import { test } from "node:test";

import { STRETCH_TECHNIQUES, assessFeasibility, getTechnique } from "./index.js";

test("registry: techniques are ranked 1..N cheapest-first, lower-quant first", () => {
  const ranks = STRETCH_TECHNIQUES.map((t) => t.rank);
  assert.deepEqual(
    [...ranks].sort((a, b) => a - b),
    ranks,
    "rank order must be ascending",
  );
  assert.equal(STRETCH_TECHNIQUES[0]?.id, "lower-quant");
  assert.ok(getTechnique("airllm"));
});

test("small model on a modest box: FITS, no suggestions", () => {
  const v = assessFeasibility({ q4Gb: 2.1, minRamGb: 8, isMoe: false }, { ramGb: 16, vramGb: 0 });
  assert.equal(v.tier, "fits");
  assert.equal(v.suggestions.length, 0);
  assert.equal(v.suggestSmaller, false);
});

test("70B dense on 16GB: STRETCH → lower-quant then AirLLM, suggest smaller", () => {
  const v = assessFeasibility({ q4Gb: 39, minRamGb: 64, isMoe: false }, { ramGb: 16, vramGb: 0 });
  assert.ok(v.tier === "stretch" || v.tier === "no-go");
  assert.equal(v.suggestSmaller, true);
  const ids = v.suggestions.map((s) => s.technique.id);
  assert.equal(ids[0], "lower-quant", "lower-quant is always first");
  assert.ok(ids.includes("airllm"), "a dense overflow should offer AirLLM");
});

test("large MoE: recommends MoE expert-offload", () => {
  const v = assessFeasibility(
    { q4Gb: 142, minRamGb: 192, isMoe: true, activeB: 22 },
    { ramGb: 32, vramGb: 24 },
  );
  const ids = v.suggestions.map((s) => s.technique.id);
  assert.ok(ids.includes("moe-expert-offload"), "MoE → expert offload");
  // a MoE should NOT lead with AirLLM layer-streaming (experts make that pointless)
  assert.ok(!ids.includes("airllm"));
});

test("671B on a laptop: NO-GO, advise served API / smaller", () => {
  const v = assessFeasibility(
    { q4Gb: 377, minRamGb: 768, isMoe: true, activeB: 37, needsOffload: true },
    { ramGb: 16, vramGb: 0 },
  );
  assert.equal(v.tier, "no-go");
  assert.equal(v.suggestSmaller, true);
});

test("unified-memory Mac uses RAM as the VRAM budget", () => {
  // 32B Q4 ~18GB footprint fits a 36GB unified Mac (budget ~27GB), not a 16GB one.
  const mac = assessFeasibility(
    { q4Gb: 18, minRamGb: 32, isMoe: false },
    { ramGb: 36, vramGb: 0, unified: true },
  );
  assert.ok(mac.tier === "fits" || mac.tier === "tight");
});
