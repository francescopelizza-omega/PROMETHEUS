/**
 * shell.test.ts — node:test for the PURE shell model (file 08 §4/§6).
 *
 * Covers exactly the brief's pure-logic seams:
 *   - activity routing (a bad/empty id degrades to Home, never an empty frame),
 *   - command-palette FUZZY filter (subsequence match + ranking),
 *   - status-bar SHIELD state from a verdict (+ DB-freshness staleness),
 *   - theme/density attribute RESOLUTION (system sync + persisted override).
 *
 * Imports only the pure modules (no React, no DOM) so it runs under
 * `node --import dev-register.mjs --test` straight from TS source.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { hasActivityIcon } from "./icon-names.js";
import {
  ACTIVITIES,
  DEFAULT_ACTIVITY,
  PINNED,
  appearanceAttributes,
  deriveShield,
  filterPalette,
  fuzzyScore,
  getActivity,
  isActivityId,
  parseAppearance,
  resolveThemeBase,
  routeActivity,
  sidebarTitle,
} from "./index.js";
import type { PaletteItem } from "./palette.js";

/* ── activity icons (APP-071) ─────────────────────────────────────────────── */

test("hasActivityIcon: every editor inner-rail + open-button icon has geometry", () => {
  // ActivityIcon renders a blank dot when a name is missing from PATHS — gate each name
  // the editor route uses so a typo can't ship an invisible rail button.
  const EDITOR_RAIL_ICONS = [
    "Files",
    "Search",
    "GitBranch",
    "Bug",
    "FlaskConical",
    "ListChecks",
    "ListTree",
    "CallHierarchy",
    "TypeHierarchy",
    "History",
    "FileText", // open-file button
    "FolderOpen", // open-folder button
  ];
  for (const name of EDITOR_RAIL_ICONS) {
    assert.equal(hasActivityIcon(name), true, `missing ActivityIcon geometry: ${name}`);
  }
  assert.equal(hasActivityIcon("NoSuchIcon"), false); // negative control
});

/* ── activity routing ────────────────────────────────────────────────────── */

test("ACTIVITIES: Home is first + all ids unique", () => {
  assert.equal(ACTIVITIES[0]!.id, "home");
  const ids = ACTIVITIES.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("ACTIVITIES: every §4.1 noun is present", () => {
  const ids = new Set(ACTIVITIES.map((a) => a.id));
  for (const id of [
    "home",
    "editor",
    "catalog",
    "models",
    "environments",
    "security",
    "repos",
    "extensions",
  ]) {
    assert.ok(ids.has(id as never), `missing activity: ${id}`);
  }
});

test("PINNED: engine status + settings are pinned-bottom", () => {
  assert.deepEqual(
    PINNED.map((p) => p.id),
    ["engine", "settings"],
  );
});

test("routeActivity: known id passes through", () => {
  assert.equal(routeActivity("models"), "models");
  assert.equal(routeActivity("editor"), "editor");
});

test("routeActivity: unknown/empty/null degrades to Home (no empty frame)", () => {
  assert.equal(routeActivity("nope"), DEFAULT_ACTIVITY);
  assert.equal(routeActivity(""), DEFAULT_ACTIVITY);
  assert.equal(routeActivity(null), DEFAULT_ACTIVITY);
  assert.equal(routeActivity(undefined), DEFAULT_ACTIVITY);
});

test("isActivityId + getActivity are consistent", () => {
  assert.ok(isActivityId("security"));
  assert.ok(!isActivityId("xyz"));
  assert.equal(getActivity("security")?.label, "Security");
  assert.equal(getActivity("xyz"), undefined);
});

test("sidebarTitle: unknown id falls back to Home label", () => {
  assert.equal(sidebarTitle("models"), "Model Hub");
  assert.equal(sidebarTitle("bogus"), "Home");
});

/* ── command-palette fuzzy filter ────────────────────────────────────────── */

test("fuzzyScore: blank query matches everything (score 0)", () => {
  const r = fuzzyScore("", "Serve qwen3");
  assert.ok(r);
  assert.equal(r.score, 0);
});

test("fuzzyScore: non-subsequence ⇒ no match", () => {
  assert.equal(fuzzyScore("zzz", "Serve qwen3"), null);
});

test("fuzzyScore: subsequence across words matches ('srvq' → 'Serve qwen3')", () => {
  const r = fuzzyScore("srvq", "Serve qwen3");
  assert.ok(r, "srvq should match Serve qwen3");
  assert.ok(r.score > 0);
});

test("fuzzyScore: prefix outscores a scattered subsequence", () => {
  const prefix = fuzzyScore("serv", "Serve qwen3");
  const scattered = fuzzyScore("sqw", "Serve qwen3");
  assert.ok(prefix && scattered);
  assert.ok(prefix.score > scattered.score, "prefix match should rank higher");
});

test("fuzzyScore: contiguous run > same chars scattered", () => {
  const contiguous = fuzzyScore("ins", "install plugin");
  const scattered = fuzzyScore("ipl", "install plugin");
  assert.ok(contiguous && scattered);
  assert.ok(contiguous.score > scattered.score);
});

test("fuzzyScore: ranges cover the matched chars", () => {
  const r = fuzzyScore("nv", "New venv");
  assert.ok(r);
  // each range maps to a real matched lowercase char
  for (const [s, e] of r.ranges) {
    assert.ok(e > s);
    assert.ok(s >= 0 && e <= "New venv".length);
  }
});

const PALETTE: PaletteItem[] = [
  { id: "models.serve", title: "Serve qwen3", kind: "command" },
  { id: "env.new", title: "New venv", kind: "command" },
  { id: "scan.repo", title: "Scan a repo", kind: "command" },
  { id: "settings.open", title: "Open Settings", kind: "command", subtitle: "preferences theme" },
  { id: "install.sp", title: "Install obra/superpowers", kind: "catalog", verdict: "scanning" },
];

test("filterPalette: blank query returns all in original order", () => {
  const out = filterPalette(PALETTE, "");
  assert.equal(out.length, PALETTE.length);
  assert.equal(out[0]!.item.id, "models.serve");
});

test("filterPalette: 'serve' ranks the Serve command first", () => {
  const out = filterPalette(PALETTE, "serve");
  assert.ok(out.length >= 1);
  assert.equal(out[0]!.item.id, "models.serve");
});

test("filterPalette: a subtitle-only match still surfaces (lower weight)", () => {
  const out = filterPalette(PALETTE, "theme");
  const ids = out.map((o) => o.item.id);
  assert.ok(ids.includes("settings.open"), "subtitle match 'theme' should surface Settings");
});

test("filterPalette: a pinned verdict survives the filter (cosmetic, C5)", () => {
  const out = filterPalette(PALETTE, "install");
  assert.equal(out[0]!.item.verdict, "scanning");
});

test("filterPalette: limit caps the result count", () => {
  const out = filterPalette(PALETTE, "", 2);
  assert.equal(out.length, 2);
});

/* ── status-bar shield state ─────────────────────────────────────────────── */

test("deriveShield: allow + fresh DB ⇒ clean (green/ok)", () => {
  const s = deriveShield("allow", { dbStale: false });
  assert.equal(s.state, "clean");
  assert.equal(s.role, "ok");
  assert.equal(s.glyph, "✓");
});

test("deriveShield: warn ⇒ warn (amber)", () => {
  const s = deriveShield("warn");
  assert.equal(s.state, "warn");
  assert.equal(s.role, "warn");
  assert.equal(s.glyph, "▲");
});

test("deriveShield: block ⇒ block (red) and outranks staleness", () => {
  const s = deriveShield("block", { dbStale: true });
  assert.equal(s.state, "block");
  assert.equal(s.role, "danger");
});

test("deriveShield: error ⇒ scan failed (fail-closed, ⚠)", () => {
  const s = deriveShield("error");
  assert.equal(s.state, "error");
  assert.equal(s.role, "danger");
  assert.equal(s.glyph, "⚠");
});

test("deriveShield: clean verdict but stale DB ⇒ stale (nudges refresh)", () => {
  const s = deriveShield("allow", { dbStale: true });
  assert.equal(s.state, "stale");
  assert.equal(s.role, "warn");
});

test("deriveShield: null verdict + fresh DB ⇒ clean placeholder", () => {
  assert.equal(deriveShield(null).state, "clean");
  assert.equal(deriveShield(undefined).state, "clean");
});

test("deriveShield: null verdict + stale DB ⇒ stale", () => {
  assert.equal(deriveShield(null, { dbStale: true }).state, "stale");
});

/* ── theme / density attribute resolution (system sync + override) ───────── */

test("resolveThemeBase: 'system' follows the OS scheme", () => {
  assert.equal(resolveThemeBase("system", "dark"), "dark");
  assert.equal(resolveThemeBase("system", "light"), "light");
});

test("resolveThemeBase: explicit override beats the OS", () => {
  assert.equal(resolveThemeBase("light", "dark"), "light");
  assert.equal(resolveThemeBase("dark", "light"), "dark");
  assert.equal(resolveThemeBase("high-contrast", "light"), "high-contrast");
});

test("parseAppearance: defaults are system + compact", () => {
  const a = parseAppearance(null);
  assert.equal(a.theme, "system");
  assert.equal(a.density, "compact");
});

test("parseAppearance: a corrupt blob falls back to defaults (fail-soft)", () => {
  const a = parseAppearance({ theme: "neon", density: "ultra" });
  assert.equal(a.theme, "system");
  assert.equal(a.density, "compact");
});

test("parseAppearance: a valid blob round-trips", () => {
  const a = parseAppearance({ theme: "high-contrast", density: "comfortable" });
  assert.equal(a.theme, "high-contrast");
  assert.equal(a.density, "comfortable");
});

test("appearanceAttributes: maps prefs+OS → the <html> attributes", () => {
  const attrs = appearanceAttributes({ theme: "system", density: "compact" }, "dark");
  assert.equal(attrs["data-theme"], "dark");
  assert.equal(attrs["data-density"], "compact");
  assert.equal(attrs["color-scheme"], "dark");
});

test("appearanceAttributes: light override reports color-scheme:light to the UA", () => {
  const attrs = appearanceAttributes({ theme: "light", density: "comfortable" }, "dark");
  assert.equal(attrs["data-theme"], "light");
  assert.equal(attrs["color-scheme"], "light");
});

test("appearanceAttributes: high-contrast paints on a dark canvas", () => {
  const attrs = appearanceAttributes({ theme: "high-contrast", density: "compact" }, "light");
  assert.equal(attrs["data-theme"], "high-contrast");
  assert.equal(attrs["color-scheme"], "dark");
});
