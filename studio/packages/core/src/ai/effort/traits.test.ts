/**
 * traits.test.ts — the model trait strip, shared by the terminal composer and the Electron rail.
 *
 * The reason this is in core at all is drift: two renderers showing the same facts in different
 * orders is the class of bug this repo keeps finding (see `effort-text.ts`'s private copy of the
 * prompt table). So the ORDER and the two-row grid are pinned here, once, and each surface only
 * owns its own padding.
 *
 * The capability lists below are real — verified against the live Ollama daemon.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { TRAIT_INLINE_MAX, modelTraits, moveTraitFocus, traitGrid, traitRail } from "./traits.js";

/** gemma4:12b — five capabilities, so six traits once the dial joins. */
const GEMMA4 = ["completion", "vision", "audio", "tools", "thinking"];
/** qwen3.6:latest — four capabilities, so five traits: an ODD count that needs padding. */
const QWEN36 = ["completion", "vision", "tools", "thinking"];

test("capabilities first, the one CONTROL last", () => {
  // Properties on the left, the dial on the right — that is what makes the strip read as
  // "here is the model, and here is your knob" rather than as undifferentiated chip soup.
  assert.deepEqual(modelTraits(QWEN36, "effort: high"), [...QWEN36, "effort: high"]);
});

test("the runner's own order is preserved, not sorted", () => {
  // `/api/show` answers in a stable per-model order. Sorting would make the strip reshuffle
  // between models for no gain.
  assert.deepEqual(modelTraits(["thinking", "tools", "completion"], "effort: low"), [
    "thinking",
    "tools",
    "completion",
    "effort: low",
  ]);
});

test("blanks and duplicates are dropped — a doubled chip reads as a bug", () => {
  assert.deepEqual(modelTraits(["tools", "", "  ", "tools", "thinking"], "effort: max"), [
    "tools",
    "thinking",
    "effort: max",
  ]);
});

test("no capabilities probed ⇒ the dial alone; no dial either ⇒ nothing", () => {
  assert.deepEqual(modelTraits(undefined, "effort: high"), ["effort: high"]);
  assert.deepEqual(modelTraits([], "effort: high"), ["effort: high"]);
  assert.deepEqual(modelTraits(GEMMA4, undefined), GEMMA4);
  assert.deepEqual(modelTraits(undefined, undefined), []);
});

test("traitGrid: null at or below the inline threshold — the single line owns that case", () => {
  for (let n = 0; n <= TRAIT_INLINE_MAX; n++) {
    const traits = Array.from({ length: n }, (_, i) => `t${i}`);
    assert.equal(traitGrid(traits), null, `${n} traits must stay inline`);
  }
});

test("traitGrid: EXACTLY two rows, whatever the trait count", () => {
  for (let n = TRAIT_INLINE_MAX + 1; n <= 20; n++) {
    const traits = Array.from({ length: n }, (_, i) => `t${i}`);
    const grid = traitGrid(traits);
    assert.ok(grid);
    assert.equal(grid?.cells.length, (grid?.cols ?? 0) * 2, `${n}: cells must fill two full rows`);
    assert.equal(grid?.cols, Math.ceil(n / 2));
  }
});

test("traitGrid: the dial is ALWAYS the last cell — bottom-right for every model", () => {
  // A control that wanders with the capability count is harder to find than one that is always
  // in the same corner — and the count changes on every model switch, which is exactly when
  // the user is looking for it.
  for (const caps of [
    GEMMA4,
    QWEN36,
    [...GEMMA4, "embedding"],
    [...GEMMA4, "embedding", "insert"],
  ]) {
    const traits = modelTraits(caps, "effort: high");
    const grid = traitGrid(traits);
    assert.equal(grid?.cells[grid.cells.length - 1], "effort: high", `${caps.length} caps`);
  }
});

test("traitGrid: padding goes BEFORE the dial, never after", () => {
  // qwen3.6: five traits into a 3x2 grid leaves one hole, and it must sit to the LEFT of the
  // dial rather than trailing it.
  const grid = traitGrid(modelTraits(QWEN36, "effort: high"));
  assert.deepEqual(grid, {
    cols: 3,
    cells: ["completion", "vision", "tools", "thinking", "", "effort: high"],
  });
});

test("traitGrid: an even count needs no padding at all", () => {
  const grid = traitGrid(modelTraits(GEMMA4, "effort: max"));
  assert.deepEqual(grid, {
    cols: 3,
    cells: ["completion", "vision", "audio", "tools", "thinking", "effort: max"],
  });
  assert.equal(
    grid?.cells.filter((c) => c === "").length,
    0,
    "a six-trait model fills the grid exactly",
  );
});

test("traitGrid: no trait is lost or duplicated by the padding", () => {
  for (const caps of [GEMMA4, QWEN36, [...GEMMA4, "embedding", "insert", "rerank"]]) {
    const traits = modelTraits(caps, "effort: high");
    const grid = traitGrid(traits);
    const kept = (grid?.cells ?? []).filter((c) => c !== "");
    assert.deepEqual(kept, traits, `${caps.length} caps: the grid changed the trait set`);
  }
});

/* ── the rail ─────────────────────────────────────────────────────────────────── */

test("the rail keeps every slot, in a FIXED order, whatever the model has", () => {
  const rail = traitRail({ capabilities: ["completion", "tools"], toolsEnabled: true });
  assert.deepEqual(
    rail.map((c) => c.id),
    ["completion", "vision", "audio", "tools", "thinking"],
    "a text-only model must not collapse the row — absence is what the dim slots report",
  );
  assert.deepEqual(
    rail.map((c) => c.state),
    ["on", "unsupported", "unsupported", "on", "unsupported"],
  );
});

test("`off` means the USER switched it off — distinct from a model that never had it", () => {
  const rail = traitRail({
    capabilities: ["completion", "tools", "thinking"],
    toolsEnabled: false,
    effort: { tier: "off", available: true },
  });
  const by = (id: string) => rail.find((c) => c.id === id);
  assert.equal(by("tools")?.state, "off", "the model HAS tools; the user turned them off");
  assert.equal(by("thinking")?.state, "off", "tier `off` IS thinking off");
  assert.equal(by("vision")?.state, "unsupported", "never had it — a different fact");
  assert.equal(by("effort")?.state, "off");
});

test("only the two real switches are actionable — an indicator says why it is not", () => {
  const rail = traitRail({
    capabilities: ["completion", "vision", "audio", "tools", "thinking"],
    toolsEnabled: true,
    effort: { tier: "high", available: true },
  });
  assert.deepEqual(
    rail.filter((c) => c.actionable).map((c) => c.id),
    ["tools", "thinking", "effort"],
  );
  // a refused key must be able to explain itself — silence reads as a broken binding.
  assert.ok(rail.every((c) => c.actionable || c.reason));
});

test("a capability the model lacks is NOT actionable — ↑ would be a lie", () => {
  const rail = traitRail({ capabilities: ["completion"], toolsEnabled: true });
  const tools = rail.find((c) => c.id === "tools");
  assert.equal(tools?.actionable, false);
  assert.match(tools?.reason ?? "", /no tool calling/);
});

test("an unprobed model has no capability slots — an all-dim rail would be a false report", () => {
  const rail = traitRail({
    capabilities: undefined,
    toolsEnabled: true,
    effort: { tier: "medium", available: true },
  });
  assert.deepEqual(
    rail.map((c) => c.id),
    ["effort"],
  );
});

test("an unavailable dial reads `n/a` and refuses ↑/↓ rather than moving a knob that is inert", () => {
  const rail = traitRail({
    capabilities: ["completion"],
    toolsEnabled: true,
    effort: { tier: "high", available: false },
  });
  const dial = rail.find((c) => c.id === "effort");
  assert.equal(dial?.label, "⚙ n/a");
  assert.equal(dial?.actionable, false);
});

test("focus wraps in both directions, over every cell (indicators included)", () => {
  const rail = traitRail({
    capabilities: ["completion", "vision", "audio", "tools", "thinking"],
    toolsEnabled: true,
    effort: { tier: "high", available: true },
  });
  assert.equal(rail.length, 6);
  assert.equal(moveTraitFocus(rail, 5, 1), 0);
  assert.equal(moveTraitFocus(rail, 0, -1), 5);
});
