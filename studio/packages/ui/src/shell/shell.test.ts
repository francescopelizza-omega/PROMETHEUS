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

import { ACTIVITY_ICON_NAMES, hasActivityIcon } from "./icon-names.js";
import {
  ACTIVITIES,
  ACTIVITY_REDIRECTS,
  DEFAULT_ACTIVITY,
  PINNED,
  RAIL_ACTIVITIES,
  appearanceAttributes,
  deriveShield,
  filterPalette,
  fuzzyScore,
  getActivity,
  isActivityId,
  parseAppearance,
  resolveActivity,
  resolveThemeBase,
  routeActivity,
  sidebarTitle,
} from "./index.js";
import type { PaletteItem } from "./palette.js";

/* ── activity icons (APP-071) ─────────────────────────────────────────────── */

test("hasActivityIcon: a name in the catalogue has geometry, an unknown one does not", () => {
  // This used to hold a HAND-COPIED list of the editor route's rail icons, and that copy is
  // precisely why two entries could ship drawing the same glyph without anything failing: the
  // real array grew a duplicate, and the test was reading a different list. The rail's own
  // contract — every icon present, and no two entries sharing one — now lives in
  // `apps/desktop/src/routes/editor-rail.test.ts`, which parses the REAL declaration.
  //
  // What belongs here is only what this package can own: the catalogue is self-consistent
  // (name↔geometry is already a TYPE error via `Record<ActivityIconName, ReactNode>`), and an
  // unknown name is reported as missing rather than silently accepted.
  for (const name of ACTIVITY_ICON_NAMES) {
    assert.equal(hasActivityIcon(name), true, `missing ActivityIcon geometry: ${name}`);
  }
  assert.equal(hasActivityIcon("NoSuchIcon"), false); // negative control
  assert.equal(hasActivityIcon(""), false);
});

/* ── activity routing ────────────────────────────────────────────────────── */

test("ACTIVITIES: Home is first + all ids unique", () => {
  assert.equal(ACTIVITIES[0]!.id, "home");
  const ids = ACTIVITIES.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("ACTIVITIES: the handoff_3 §1 rail is exactly six nouns, in order", () => {
  assert.deepEqual(
    RAIL_ACTIVITIES.map((a) => a.id),
    ["home", "editor", "catalog", "models", "security", "workspace"],
  );
  // `chat` stays a real route without a rail icon (the agent lives in the RightRail).
  assert.ok(ACTIVITIES.some((a) => a.id === "chat" && a.rail === false));
});

test("the four retired activities redirect to their merged route + segment", () => {
  // These ids are on disk in `prometheus.layout` for anyone who quit before the merge.
  // Losing this table does not remove the persisted value — it just turns a working
  // migration back into a blank frame.
  assert.deepEqual(resolveActivity("repos"), { activity: "workspace", tab: "repos" });
  assert.deepEqual(resolveActivity("environments"), {
    activity: "workspace",
    tab: "environments",
  });
  assert.deepEqual(resolveActivity("docs"), { activity: "workspace", tab: "docs" });
  assert.deepEqual(resolveActivity("extensions"), { activity: "catalog", tab: "extensions" });
});

test("resolveActivity: a live id passes through with no tab; junk degrades to Home", () => {
  assert.deepEqual(resolveActivity("security"), { activity: "security" });
  assert.deepEqual(resolveActivity("nope"), { activity: DEFAULT_ACTIVITY });
  assert.deepEqual(resolveActivity(null), { activity: DEFAULT_ACTIVITY });
});

test("no retired id is still a live activity (the merge is complete)", () => {
  for (const dead of Object.keys(ACTIVITY_REDIRECTS)) {
    assert.ok(!isActivityId(dead), `${dead} should have been merged away`);
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
  assert.equal(sidebarTitle("workspace"), "Workspace");
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

/* ── armed: is there a SCANNER at all (handoff §2.3.1/§7 "gate armed") ───── */

test("deriveShield: a CONFIRMED-present scanner with nothing scanned reads 'armed'", () => {
  const s = deriveShield(null, { armed: true });
  assert.equal(s.state, "armed");
  assert.equal(s.label, "armed");
  assert.equal(s.role, "ok");
});

test("deriveShield: an ABSENT scanner outranks every verdict and is never green", () => {
  // this is the whole point: before `armed`, a build with nemesis missing fell through
  // to the benign `clean` placeholder and painted the chip GREEN while nothing at all
  // was being gated.
  for (const v of [null, undefined, "allow", "warn", "block", "error"] as const) {
    const s = deriveShield(v, { armed: false });
    assert.equal(s.state, "unarmed", `verdict ${String(v)} must not outrank a missing scanner`);
    assert.equal(s.role, "danger");
    assert.equal(s.label, "unarmed");
  }
  // …and staleness cannot soften it either
  assert.equal(deriveShield(null, { armed: false, dbStale: true }).state, "unarmed");
});

test("deriveShield: armed only speaks when the caller HAS a probe", () => {
  // undefined = "we have not looked", which must behave exactly as before — the chip
  // may not accuse a scanner nobody asked about.
  assert.equal(deriveShield(null, {}).state, "clean");
  assert.equal(deriveShield(null).state, "clean");
  // a real verdict still wins over the bare "armed" placeholder
  assert.equal(deriveShield("warn", { armed: true }).state, "warn");
  assert.equal(deriveShield("allow", { armed: true }).state, "clean");
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
