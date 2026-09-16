/**
 * stream-line-level.test.ts — the two streamed panes actually get their colours.
 *
 * Both long-running streams mapped their lines to `{id, text}` with no `level`, and
 * `StreamLog` reads tint AND glyph from `level` alone. So handoff_3 §2's six colour classes
 * for the catalog install log, and §4's "✓ done green, … active amber" for the remediation
 * feed, collapsed to one grey with a blank glyph in both panes. Two specs, one missing
 * field, and nothing in the suite could see it because the classification did not exist at
 * any layer to be tested.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyStreamLine, streamLineLevel } from "./stream-line-level.js";

const HERE = dirname(fileURLToPath(import.meta.url));

test("markers win, in both kinds", () => {
  for (const kind of ["lifecycle", "remediation"] as const) {
    assert.equal(streamLineLevel("✓ removed postinstall script", kind), "success");
    assert.equal(streamLineLevel("✗ could not rewrite", kind), "error");
    assert.equal(streamLineLevel("… rewriting fetch calls (2 of 3)", kind), "warn");
    assert.equal(streamLineLevel("⚠ partial", kind), "warn");
    assert.equal(streamLineLevel("   ✓ leading space", kind), "success", "trim first");
  }
});

test("the catalog pipeline's own vocabulary (handoff_3 §2's six classes)", () => {
  const L = (t: string): string => streamLineLevel(t, "lifecycle");
  // the exact lines the prototype shows, in order
  assert.equal(L("$ prometheus catalog install frontend-design --dry-run"), "debug", "command");
  assert.equal(L("fetch  github.com/anthropics/frontend-design @ v2.4.1"), "info", "body");
  assert.equal(L("unpack 38 files → staging (no exec)"), "info", "body");
  assert.equal(L("nemesis scan · 38 files · 412 ms · 2 findings"), "success", "scan");
  assert.equal(L("  N-204  curl piped to shell — setup.sh:41"), "warn", "finding");
  assert.equal(L("  N-011  suppressed — non-executable docs"), "debug", "suppressed");
  assert.equal(L("verdict: WARN — confirmation required, nothing installed"), "warn");
});

test("the ENGINE's real vocabulary — a word prefix, not a glyph", () => {
  /**
   * The classifier was written against a prototype's glyphs (✓ ✗ … ⚠). The lines that actually
   * reach these panes are the engine's human stderr, forwarded verbatim, and every `Log` method
   * stamps a WORD: `:: `, `OK `, `WARN `, `FAIL `, `    -> `, `    dbg `. So nothing matched,
   * both panes stayed a uniform grey, and `FAIL …` — a hard failure — was tinted neutral.
   */
  const L = (t: string): string => streamLineLevel(t, "lifecycle");
  assert.equal(L("OK scan clean — no known-bad patterns in executable install code"), "success");
  assert.equal(L("FAIL could not stage the archive"), "error");
  assert.equal(L(":: fetching tarball"), "info");
  // the prefix level is a FLOOR, not a re-run: nothing in this remainder is a keyword, and it
  // must still come out green rather than falling back to info.
  assert.equal(L("OK source previously approved (trust store) — proceeding"), "success");
  // …but a rule may ESCALATE it: the verdict line is `Log.warn`, and its tier is what decides.
  assert.equal(
    L("WARN verdict: CRITICAL  (crit 2 / high 0 / med 1 / low 0)  [0 suppressed]"),
    "error",
    "the most serious line the pipeline prints must not be amber",
  );
  assert.equal(L("WARN verdict: ALLOW  [2 suppressed]"), "success");
  // `[N suppressed]` is on EVERY verdict line, so the suppressed rule must not grey it out
  assert.equal(L("verdict: MEDIUM  (crit 0 / high 0 / med 1 / low 0)  [3 suppressed]"), "warn");
  // …and the tier comes from the TOKEN after `verdict:`, never from the count breakdown: a
  // MEDIUM verdict whose line reads "high 0" is not an error.
  assert.equal(L("verdict: LOW  (crit 0 / high 0 / med 0 / low 2)  [1 suppressed]"), "warn");
  assert.equal(L("WARN verdict: HIGH  (crit 0 / high 3 / med 0 / low 0)  [0 suppressed]"), "error");
  // Log.step keeps its indent hierarchy: not levelled by prefix, greyed by the suppressed rule
  assert.equal(L("    -> 3 non-executable match(es) suppressed"), "debug");
});

test("a FINDING line carries its own severity — printed raw, with no Log prefix", () => {
  // "      HIGH [N-204] setup.sh:41  curl piped to shell" (prometheus.py's _print_findings)
  const L = (t: string): string => streamLineLevel(t, "lifecycle");
  assert.equal(L("      CRITICAL [N-101] install.sh:3  remote code executed at install"), "error");
  assert.equal(L("      HIGH [N-204] setup.sh:41  curl piped to shell"), "error");
  assert.equal(L("      MEDIUM [N-311] build.js:12  writes outside the package"), "warn");
  assert.equal(L("      LOW [N-402] docs/x.md:1  mentions a token"), "warn");
  assert.equal(L("      INFO [N-011] README.md:9  non-executable match"), "debug");
  // its two continuation lines read as subordinate to the finding above them
  assert.equal(L("          ↳ curl -sSL https://x/y | sh"), "debug");
  assert.equal(L("          fix: pin the version and verify the checksum"), "debug");
});

test("an outcome WORD prefix is consumed, not printed beside StreamLog's own glyph", () => {
  assert.deepEqual(classifyStreamLine("OK scan clean", "lifecycle"), {
    level: "success",
    text: "scan clean",
  });
  assert.deepEqual(classifyStreamLine("FAIL could not stage the archive", "lifecycle"), {
    level: "error",
    text: "could not stage the archive",
  });
  // a word that merely STARTS with an outcome token is untouched — the prefix needs its space
  assert.equal(classifyStreamLine("OKAY, continuing").text, "OKAY, continuing");
  assert.equal(classifyStreamLine("WARNING: unusual").text, "WARNING: unusual");
  // `-> ` and `dbg ` encode the engine's step hierarchy through their indent — the prefix is not
  // consumed AND the indent is not trimmed, so the pipeline keeps its shape in the pane.
  assert.equal(
    classifyStreamLine("    -> staging 38 files", "lifecycle").text,
    "    -> staging 38 files",
  );
});

test("a BLOCK verdict is not amber — the tier decides, not the word 'verdict'", () => {
  assert.equal(streamLineLevel("verdict: BLOCK — refused", "lifecycle"), "error");
  assert.equal(streamLineLevel("verdict: ALLOW — clean", "lifecycle"), "success");
});

test("lifecycle vocabulary does NOT leak into the remediation pane", () => {
  // "fetch …" in a remediation stream is not a pipeline stage; classifying it as one would
  // be a guess dressed as a colour.
  assert.equal(streamLineLevel("N-204 something", "remediation"), "info");
  assert.equal(streamLineLevel("verdict: WARN", "remediation"), "warn", "via the word 'warn'");
});

test("an unrecognised line stays neutral — never a guessed ✓", () => {
  assert.equal(streamLineLevel("remediate shadow-fetch → strip network hooks"), "info");
  assert.equal(streamLineLevel("scanning 41 files"), "info");
  assert.equal(streamLineLevel(""), "info");
  assert.equal(streamLineLevel("   "), "info");
});

test("outcome words are honoured in either pane", () => {
  assert.equal(streamLineLevel("disinfect failed for 1 item"), "error");
  assert.equal(streamLineLevel("2 findings unresolved"), "warn");
});

/* ── the gutter glyph must not be printed twice ─────────────────────────────────── */

test("a marker that SET the level is not also printed", () => {
  // StreamLog stamps its own ✓ / ▲ / ✗ per level, so a line carrying the marker in its text
  // rendered it twice — "✓ ✓ removed postinstall script". The colour change introduced this.
  assert.deepEqual(classifyStreamLine("✓ removed postinstall script"), {
    level: "success",
    text: "removed postinstall script",
  });
  assert.deepEqual(classifyStreamLine("… rewriting fetch calls (2 of 3)"), {
    level: "warn",
    text: "rewriting fetch calls (2 of 3)",
  });
  assert.deepEqual(classifyStreamLine("✗ could not rewrite"), {
    level: "error",
    text: "could not rewrite",
  });
});

test("a marker mid-sentence, or a level from a KEYWORD, leaves the text alone", () => {
  // the goal is not duplicating the gutter glyph, not editing the engine's prose
  assert.deepEqual(classifyStreamLine("disinfect failed for 1 item"), {
    level: "error",
    text: "disinfect failed for 1 item",
  });
  assert.equal(classifyStreamLine("rewrote 3 of 4 ⚠ paths").text, "rewrote 3 of 4 ⚠ paths");
  assert.equal(classifyStreamLine("scanning 41 files").text, "scanning 41 files");
});

test("a lifecycle line keeps its indentation-bearing prose", () => {
  const c = classifyStreamLine("  N-204  curl piped to shell — setup.sh:41", "lifecycle");
  assert.equal(c.level, "warn");
  assert.match(c.text, /N-204/, "the rule id is not a marker and must survive");
});

/* ── the call sites, because a classifier nobody calls changes nothing ──────────── */

test("DRIFT GUARD: both streamed panes pass a level to StreamLog", () => {
  const catalog = readFileSync(join(HERE, "catalog.tsx"), "utf8");
  assert.match(
    catalog,
    /\.\.\.classifyStreamLine\(raw, "lifecycle"\)/,
    "the catalog install log went back to uncoloured (or double-marked) lines",
  );
  const security = readFileSync(join(HERE, "security.tsx"), "utf8");
  assert.match(
    security,
    /\.\.\.classifyRemediationLine\(raw\)/,
    "the remediation feed went back to uncoloured (or double-marked) lines",
  );
});

test("DRIFT GUARD: the remediation classifier is not a second copy", () => {
  const view = readFileSync(join(HERE, "security-console-view.ts"), "utf8");
  assert.match(view, /return streamLineLevel\(text, "remediation"\)/);
  assert.match(view, /return classifyStreamLine\(text, "remediation"\)/);
  assert.doesNotMatch(
    view,
    /startsWith\("✓"\)/,
    "a local twin of the marker table is back in security-console-view",
  );
});
