/**
 * render/reach-matrix.test.ts — node:test unit tests for the reach-matrix
 * projector. Color is forced OFF so assertions match the plain visible text
 * (deterministic across TTY/NO_COLOR environments). No test framework, no new
 * deps; imports straight from source.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { MatrixEnvelope } from "@prometheus/engine-bridge";

import { setColorEnabled } from "../render.js";
import { renderReachMatrix } from "./reach-matrix.js";

// Force color off for the whole file so we assert on plain glyphs/text, then
// restore the default afterward so we don't leak global state to other suites.
before(() => setColorEnabled(false));
after(() => setColorEnabled(true));

/** A small, realistic matrix envelope (mirrors `prometheus.py --json matrix`). */
function sampleMatrix(): MatrixEnvelope {
  return {
    command: "matrix",
    ok: true,
    agents: ["claude", "codex", "cursor"],
    reach: [
      // claude-only plugin: native to claude, nothing else.
      {
        plugin: "claude-skill",
        scope: "C",
        native: ["claude"],
        sync: [],
        unavailable: ["codex", "cursor"],
      },
      // universal plugin: native to claude, synced to codex, can't reach cursor.
      {
        plugin: "universal-mcp",
        scope: "U",
        native: ["claude"],
        sync: ["codex"],
        unavailable: ["cursor"],
      },
    ],
  } as MatrixEnvelope;
}

test("renderReachMatrix: returns a box-drawn grid with header + plugins", () => {
  const out = renderReachMatrix(sampleMatrix());
  assert.match(out, /Reach matrix/);
  // box corners present
  assert.ok(out.includes("┌") && out.includes("┐"));
  assert.ok(out.includes("└") && out.includes("┘"));
  // header columns
  assert.match(out, /PLUGIN/);
  assert.match(out, /claude/);
  assert.match(out, /codex/);
  assert.match(out, /cursor/);
  // both plugin rows
  assert.match(out, /claude-skill/);
  assert.match(out, /universal-mcp/);
});

test("renderReachMatrix: glyphs encode native / sync / none", () => {
  const out = renderReachMatrix(sampleMatrix());
  // native (●), sync (◐) and none (○) glyphs all appear.
  assert.ok(out.includes("●"), "expected native glyph ●");
  assert.ok(out.includes("◐"), "expected sync glyph ◐");
  assert.ok(out.includes("○"), "expected none glyph ○");
});

test("renderReachMatrix: scope column shown by default, hidden when off", () => {
  const withScope = renderReachMatrix(sampleMatrix());
  assert.match(withScope, /SCOPE/);

  const noScope = renderReachMatrix(sampleMatrix(), { showScope: false });
  assert.doesNotMatch(noScope, /SCOPE/);
});

test("renderReachMatrix: bare mode drops heading + legend", () => {
  const out = renderReachMatrix(sampleMatrix(), { bare: true });
  assert.doesNotMatch(out, /Reach matrix/);
  assert.doesNotMatch(out, /legend:/);
  // grid itself still rendered
  assert.ok(out.includes("┌"));
  assert.match(out, /claude-skill/);
});

test("renderReachMatrix: legend present in non-bare mode", () => {
  const out = renderReachMatrix(sampleMatrix());
  assert.match(out, /legend:/);
  assert.match(out, /native/);
  assert.match(out, /sync/);
  assert.match(out, /none/);
});

test("renderReachMatrix: agents override reorders/limits columns", () => {
  const out = renderReachMatrix(sampleMatrix(), { agents: ["cursor"] });
  assert.match(out, /cursor/);
  // codex/claude headers excluded when only cursor requested.
  assert.doesNotMatch(out, /\bcodex\b/);
});

test("renderReachMatrix: empty agents -> honest one-liner, no box", () => {
  const empty: MatrixEnvelope = {
    command: "matrix",
    ok: true,
    agents: [],
    reach: [],
  } as MatrixEnvelope;
  const out = renderReachMatrix(empty);
  assert.match(out, /No reach data\./);
  assert.ok(!out.includes("┌"), "should not draw an empty box");
});

test("renderReachMatrix: empty reach -> honest one-liner even with agents", () => {
  const noReach: MatrixEnvelope = {
    command: "matrix",
    ok: true,
    agents: ["claude"],
    reach: [],
  } as MatrixEnvelope;
  const out = renderReachMatrix(noReach);
  assert.match(out, /No reach data\./);
});

test("renderReachMatrix: rows stay column-aligned (visible widths consistent)", () => {
  const out = renderReachMatrix(sampleMatrix(), { bare: true });
  const lines = out.split("\n").filter((l) => l.startsWith("│"));
  assert.ok(lines.length >= 3, "expected header + 2 body rows inside borders");
  // With color disabled, every bordered row must have identical visible width.
  const widths = new Set(lines.map((l) => l.length));
  assert.equal(widths.size, 1, `bordered rows misaligned: widths=${[...widths].join(",")}`);
});

test("renderReachMatrix: width hint widens the plugin column to fill a pane", () => {
  const narrow = renderReachMatrix(sampleMatrix(), { bare: true });
  const wide = renderReachMatrix(sampleMatrix(), { bare: true, width: 80 });
  const narrowW = (narrow.split("\n").find((l) => l.startsWith("│")) ?? "").length;
  const wideW = (wide.split("\n").find((l) => l.startsWith("│")) ?? "").length;
  assert.ok(wideW > narrowW, `width hint should widen the grid (${narrowW} -> ${wideW})`);
  // a too-small / undefined hint must never shrink content below natural width.
  const tiny = renderReachMatrix(sampleMatrix(), { bare: true, width: 1 });
  const tinyW = (tiny.split("\n").find((l) => l.startsWith("│")) ?? "").length;
  assert.equal(tinyW, narrowW, "sub-natural width hint must not shrink the grid");
});

test("renderReachMatrix: unknown scope code falls back to a tag, no throw", () => {
  const weird: MatrixEnvelope = {
    command: "matrix",
    ok: true,
    agents: ["claude"],
    reach: [{ plugin: "p", scope: "", native: ["claude"], sync: [], unavailable: [] }],
  } as MatrixEnvelope;
  const out = renderReachMatrix(weird);
  // empty scope renders as the "?" fallback tag.
  assert.match(out, /\?/);
});
