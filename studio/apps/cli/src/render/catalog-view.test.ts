/**
 * render/catalog-view.test.ts — node:test unit tests for the P3 catalog
 * projectors. Color is forced OFF (setColorEnabled(false)) so assertions match
 * plain substrings deterministically regardless of TTY/NO_COLOR.
 *
 * Runs under Node's native type-stripping (node --test src/render/...) — no
 * test framework, no new deps; the projectors are pure so all inputs are fakes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CatalogEntry } from "@prometheus/engine-bridge";

import { setColorEnabled } from "../render.js";
import { type ItemCard, renderCatalogList, renderItemCard } from "./catalog-view.js";

// Plain (no ANSI) output makes the substring assertions stable.
setColorEnabled(false);

// --------------------------------------------------------------------------- //
// fixtures
// --------------------------------------------------------------------------- //

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    name: "caveman",
    tier: "community",
    summary: "Ultra-compressed communication mode for terse output.",
    repo: "github.com/example/caveman",
    stars: 1234,
    license: "MIT",
    scope: "universal",
    supported_os: ["macos", "linux"],
    recommend_rank: 3,
    targets: {
      claude: { method: "marketplace", installed: true },
      cursor: { method: "mcp", installed: false },
    },
    ...over,
  };
}

function card(over: Partial<ItemCard> = {}): ItemCard {
  return {
    id: "crewai",
    kind: "model_tool",
    name: "CrewAI",
    summary: "Framework for orchestrating role-playing autonomous AI agents.",
    repo: "github.com/joaomdmoura/crewAI",
    license: "MIT",
    category: "library",
    tier: "community",
    security: "Runs arbitrary Python; review tasks before granting tools.",
    installable: true,
    has_tutorial: true,
    ...over,
  };
}

// --------------------------------------------------------------------------- //
// renderCatalogList
// --------------------------------------------------------------------------- //

test("renderCatalogList: empty catalog renders a placeholder, never empty", () => {
  const out = renderCatalogList([]);
  assert.equal(out, "No catalog entries.");
});

test("renderCatalogList: table layout shows headers + a row per entry", () => {
  const out = renderCatalogList([entry(), entry({ name: "vault", tier: "official" })]);
  // headers
  assert.match(out, /NAME/);
  assert.match(out, /TIER/);
  assert.match(out, /SCOPE/);
  assert.match(out, /REACH/);
  assert.match(out, /STARS/);
  assert.match(out, /LICENSE/);
  // rows
  assert.match(out, /caveman/);
  assert.match(out, /vault/);
  // tier + scope cells
  assert.match(out, /community/);
  assert.match(out, /official/);
  assert.match(out, /universal/);
  // line count: header + 2 rows
  assert.equal(out.split("\n").length, 3);
});

test("renderCatalogList: reach cell is installed/total over targets", () => {
  // 1 of 2 targets installed.
  const out = renderCatalogList([entry()]);
  assert.match(out, /1\/2/);
});

test("renderCatalogList: stars are compacted; null renders an em dash", () => {
  const withStars = renderCatalogList([entry({ stars: 12000 })]);
  assert.match(withStars, /12k/);
  const noStars = renderCatalogList([entry({ stars: null })]);
  assert.match(noStars, /—/);
});

test("renderCatalogList: compact layout is one line per entry with summary", () => {
  const out = renderCatalogList([entry(), entry({ name: "nemesis" })], { layout: "compact" });
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /caveman/);
  assert.match(lines[0] ?? "", /Ultra-compressed/);
  assert.match(lines[1] ?? "", /nemesis/);
});

test("renderCatalogList: optional title is prepended", () => {
  const out = renderCatalogList([entry()], { title: "Catalog (community)" });
  assert.ok(out.startsWith("Catalog (community)"));
});

// --------------------------------------------------------------------------- //
// renderItemCard
// --------------------------------------------------------------------------- //

test("renderItemCard: header carries name, kind badge and id", () => {
  const out = renderItemCard(card());
  const head = out.split("\n")[0] ?? "";
  assert.match(head, /CrewAI/);
  assert.match(head, /model tool/);
  assert.match(head, /crewai/);
});

test("renderItemCard: metadata stanza + security note render verbatim", () => {
  const out = renderItemCard(card());
  assert.match(out, /repo:/);
  assert.match(out, /category:/);
  assert.match(out, /license:/);
  assert.match(out, /installable:/);
  // installable=true → "yes"; security note passed through unchanged.
  assert.match(out, /yes/);
  assert.match(out, /Runs arbitrary Python/);
});

test("renderItemCard: documented-only item reports no install path", () => {
  const out = renderItemCard(card({ installable: false, kind: "documented" }));
  assert.match(out, /documented-only/);
});

test("renderItemCard: methods + tutorial markdown sections appear when present", () => {
  const out = renderItemCard(
    card({
      methods: "## Install\n\n- pip install crewai\n- uv add crewai\n",
      tutorial: "# CrewAI\n\nDefine agents, then a crew...\n",
    }),
  );
  assert.match(out, /Install methods/);
  assert.match(out, /pip install crewai/);
  assert.match(out, /Tutorial/);
  assert.match(out, /Define agents/);
});

test("renderItemCard: tutorial hint shown when available but not fetched", () => {
  const out = renderItemCard(card({ has_tutorial: true, tutorial: undefined }));
  assert.match(out, /prom tutorial crewai/);
});

test("renderItemCard: no tutorial hint when none exists", () => {
  const out = renderItemCard(card({ has_tutorial: false, tutorial: undefined }));
  assert.doesNotMatch(out, /prom tutorial/);
});

test("renderItemCard: output is plain (no ANSI escapes / no box-drawing)", () => {
  const out = renderItemCard(card({ methods: "## Install\n\npip install crewai\n" }));
  // pager-friendly: no ESC sequences (color forced off) and no box characters.
  assert.doesNotMatch(out, /\x1b\[/);
  assert.doesNotMatch(out, /[│┌┐└┘├┤┬┴┼─]/);
});
