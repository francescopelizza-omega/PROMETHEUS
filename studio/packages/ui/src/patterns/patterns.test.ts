/**
 * patterns.test.ts — node:test for the PURE §3.2 product-pattern helpers (08 §3.2).
 * NO React rendering (no DOM here) — this exercises only the dependency-free
 * projections the patterns lean on:
 *
 *   - inert                     sanitises untrusted engine strings (ANSI + control),
 *   - verdict*                  tier → {role,glyph,label,var} (allow=ok, error=danger),
 *   - severity* / sortFindings  finding severity → projection + loudest-first sort,
 *   - klass*                    finding klass → tint role/var (icon tint only),
 *   - state*                    component-state pill → {role,glyph,var},
 *   - risk* / clampRisk         risk 0–100 → band by the verdict thresholds (fail-closed),
 *   - tier* / isDocumentedOnly  catalog tier → {glyph,label} + documented-only flag,
 *   - presence* / counts*       superscan presence → dot + the `Np Ss …` counts string,
 *   - streamLevel*              log level → severity tint,
 *   - shieldTier / engineSummary the §5.2 status-bar shield (FAIL-CLOSED),
 *   - format* / fitMeter* / meterBar  the row + VRAM-meter formatters.
 *
 * GOLDEN RULE pin (C5): a block/error verdict NEVER maps to an "ok" role; a garbage
 * risk score NEVER bands to "ok"; a degraded engine NEVER yields an "allow" shield;
 * an OVERFLOW quant NEVER yields a "fits" meter — these render the engine verdict,
 * they never decide it. The verdict glyph/label set is pinned byte-identical to the
 * tokens.ts source of truth (08 rule #1: the verdict must not drift GUI↔TUI).
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test patterns.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { VERDICT_GLYPH, VERDICT_LABEL, VERDICT_ROLE, type VerdictTier } from "../tokens.js";
import type { PatternFinding } from "./types.js";
import {
  type EngineProbe,
  clampFitRatio,
  clampRisk,
  countsLabel,
  countsTotal,
  engineSummary,
  fitMeterRole,
  formatBytes,
  formatCount,
  inert,
  isDocumentedOnly,
  klassRole,
  klassVar,
  meterBar,
  presenceGlyph,
  presenceRole,
  riskBand,
  riskFraction,
  riskVar,
  roleVar,
  severityGlyph,
  severityKey,
  severityRank,
  severityRole,
  severityVar,
  shieldTier,
  sortFindings,
  stateGlyph,
  stateRole,
  streamLevelRole,
  streamLevelVar,
  tierGlyph,
  tierLabel,
  verdictGlyph,
  verdictLabel,
  verdictRole,
  verdictVar,
} from "./util.js";

const ALL_TIERS: VerdictTier[] = ["allow", "warn", "block", "error"];

/* ── inert ────────────────────────────────────────────────────────────────── */

test("inert strips ANSI escapes + control bytes, trims, rejects non-strings", () => {
  const esc = String.fromCharCode(0x1b);
  assert.equal(inert(`${esc}[31mqwen3${esc}[0m`), "qwen3");
  // a bare control byte collapses to a space (then trim leaves the interior space).
  assert.equal(inert(`a${String.fromCharCode(0x07)}b`), "a b");
  assert.equal(inert("  spaced  "), "spaced");
  assert.equal(inert(undefined), "");
  assert.equal(inert(42 as unknown), "");
});

/* ── verdict projection — pinned to tokens.ts (no GUI↔TUI drift) ──────────── */

test("verdict role/glyph/label match the tokens.ts source of truth byte-for-byte", () => {
  for (const tier of ALL_TIERS) {
    assert.equal(verdictRole(tier), VERDICT_ROLE[tier]);
    assert.equal(verdictGlyph(tier), VERDICT_GLYPH[tier]);
    assert.equal(verdictLabel(tier), VERDICT_LABEL[tier]);
  }
  // allow renders the friendly "CLEAN" label + the green ok role.
  assert.equal(verdictLabel("allow"), "CLEAN");
  assert.equal(verdictRole("allow"), "ok");
  assert.equal(verdictVar("allow"), "var(--ok)");
});

test("verdict projection fails closed for block/error (never ok) + handles undefined", () => {
  assert.equal(verdictRole("block"), "danger");
  assert.equal(verdictRole("error"), "danger");
  assert.equal(verdictVar("block"), "var(--danger)");
  assert.equal(verdictVar("error"), "var(--danger)");
  // undefined ⇒ a calm pending descriptor, NEVER an allow.
  assert.equal(verdictRole(undefined), "text-secondary");
  assert.equal(verdictLabel(undefined), "PENDING");
  assert.notEqual(verdictRole(undefined), "ok");
});

test("roleVar maps text-secondary to its own var, others to --role", () => {
  assert.equal(roleVar("ok"), "var(--ok)");
  assert.equal(roleVar("danger"), "var(--danger)");
  assert.equal(roleVar("text-secondary"), "var(--text-secondary)");
});

/* ── severity projection + sort ───────────────────────────────────────────── */

test("severityKey maps UPPERCASE engine severity to the lowercase token key", () => {
  assert.equal(severityKey("CRITICAL"), "critical");
  assert.equal(severityKey("HIGH"), "high");
  assert.equal(severityKey("MEDIUM"), "medium");
  assert.equal(severityKey("LOW"), "low");
  assert.equal(severityKey("INFO"), "clean");
});

test("severityKey is case-insensitive and FAILS CLOSED (engine lowercase + garbage)", () => {
  // The engine emits lowercase severities (prometheus.py) — must NOT fall to clean.
  assert.equal(severityKey("critical"), "critical");
  assert.equal(severityKey("high"), "high");
  assert.equal(severityKey("info"), "clean");
  assert.equal(severityRole("critical"), "danger");
  assert.equal(severityGlyph("critical"), "⛔");
  assert.equal(severityRank("critical"), 4);
  // An unrecognized non-empty value resolves to the LOUDEST descriptor, never clean.
  assert.equal(severityKey("garbage"), "critical");
  assert.equal(severityRole("garbage"), "danger");
  assert.equal(severityRank("garbage"), 4);
});

test("severity role/var/glyph project correctly; CRITICAL/HIGH are danger", () => {
  assert.equal(severityRole("CRITICAL"), "danger");
  assert.equal(severityRole("HIGH"), "danger");
  assert.equal(severityRole("MEDIUM"), "warn");
  assert.equal(severityRole("LOW"), "ok");
  assert.equal(severityRole("INFO"), "text-secondary");
  assert.equal(severityVar("CRITICAL"), "var(--danger)");
  assert.equal(severityGlyph("CRITICAL"), "⛔");
  assert.equal(severityGlyph("INFO"), "✓");
});

test("severityRank orders CRITICAL>HIGH>MEDIUM>LOW>INFO; sortFindings is loudest-first + stable", () => {
  assert.ok(severityRank("CRITICAL") > severityRank("HIGH"));
  assert.ok(severityRank("HIGH") > severityRank("MEDIUM"));
  assert.ok(severityRank("LOW") > severityRank("INFO"));
  const mk = (severity: PatternFinding["severity"], rule_id: string): PatternFinding => ({
    severity,
    rule_id,
    rel_path: "a.py",
    klass: "malware",
  });
  const input = [mk("LOW", "L1"), mk("CRITICAL", "C1"), mk("LOW", "L2"), mk("HIGH", "H1")];
  const out = sortFindings(input).map((f) => f.rule_id);
  assert.deepEqual(out, ["C1", "H1", "L1", "L2"]); // stable within LOW (L1 before L2).
  // pure: the input array is untouched.
  assert.equal(input[0]!.rule_id, "L1");
});

/* ── klass tint ───────────────────────────────────────────────────────────── */

test("klass tint roles match the §2.2 map; unknown klass is muted (never loud)", () => {
  assert.equal(klassRole("malware"), "danger");
  assert.equal(klassRole("secret"), "warn");
  assert.equal(klassRole("vuln"), "warn");
  assert.equal(klassRole("sca"), "info");
  assert.equal(klassRole("totally-unknown"), "text-secondary");
  assert.equal(klassVar("malware"), "var(--danger)");
});

/* ── component-state pill ─────────────────────────────────────────────────── */

test("state pill role/glyph project the §2.2 lifecycle tokens; pending is muted/accent", () => {
  assert.equal(stateRole("enabled"), "ok");
  assert.equal(stateRole("installed"), "ok");
  assert.equal(stateRole("disabled"), "warn");
  assert.equal(stateRole("missing"), "warn");
  assert.equal(stateRole("muted"), "accent");
  assert.equal(stateRole("absent"), "text-disabled");
  assert.equal(stateRole("pending"), "accent");
  assert.equal(stateGlyph("enabled"), "●");
  assert.equal(stateGlyph("pending"), "◐");
  assert.equal(stateGlyph("missing"), "✗");
  assert.equal(stateGlyph("absent"), "○");
});

/* ── risk band — the §5.2 thresholds, fail-closed ────────────────────────── */

test("riskBand buckets by block>=70, warn>=30; garbage fails CLOSED to danger", () => {
  assert.equal(riskBand(0), "ok");
  assert.equal(riskBand(29), "ok");
  assert.equal(riskBand(30), "warn");
  assert.equal(riskBand(69), "warn");
  assert.equal(riskBand(70), "danger");
  assert.equal(riskBand(82), "danger");
  assert.equal(riskBand(100), "danger");
  // fail-closed: NaN/garbage ⇒ danger, NEVER ok.
  assert.equal(riskBand(Number.NaN), "danger");
  assert.equal(riskBand(Number.POSITIVE_INFINITY), "danger");
  assert.equal(riskVar(82), "var(--danger)");
  assert.equal(riskVar(10), "var(--ok)");
});

test("clampRisk + riskFraction clamp to [0,100]/[0,1]; garbage ⇒ 100/1 (fail-closed)", () => {
  assert.equal(clampRisk(150), 100);
  assert.equal(clampRisk(-5), 0);
  assert.equal(clampRisk(42), 42);
  assert.equal(clampRisk(Number.NaN), 100);
  assert.equal(riskFraction(50), 0.5);
  assert.equal(riskFraction(Number.NaN), 1);
});

/* ── catalog tier ─────────────────────────────────────────────────────────── */

test("catalog tier glyph/label + documented-only routing", () => {
  assert.equal(tierGlyph("official"), "◆");
  assert.equal(tierGlyph("external"), "✓");
  assert.equal(tierGlyph("documented"), "ⓘ");
  assert.equal(tierLabel("documented"), "documented-only");
  assert.equal(isDocumentedOnly("documented"), true);
  assert.equal(isDocumentedOnly("external"), false);
  assert.equal(isDocumentedOnly("official"), false);
});

/* ── agent presence + counts ──────────────────────────────────────────────── */

test("presence dot/role match the TUI ScanView (● present ◐ forgotten ○ absent)", () => {
  assert.equal(presenceGlyph("present"), "●");
  assert.equal(presenceGlyph("forgotten"), "◐");
  assert.equal(presenceGlyph("absent"), "○");
  assert.equal(presenceRole("present"), "ok");
  assert.equal(presenceRole("forgotten"), "warn");
  assert.equal(presenceRole("absent"), "text-secondary");
});

test("countsLabel renders Np Ss Mm Xx Rr Cc, omitting zero/undefined facets", () => {
  assert.equal(countsLabel({ plugins: 3, skills: 2, mcp: 0, commands: 5 }), "3p 2s 5c");
  // `extensions` is the engine's `x` facet (prometheus.py counts key).
  assert.equal(countsLabel({ extensions: 1, rules: 4 }), "1x 4r");
  assert.equal(countsLabel({}), "");
  assert.equal(countsLabel(undefined), "");
  assert.equal(countsTotal({ plugins: 3, skills: 2, extensions: 5 }), 10);
  assert.equal(countsTotal(undefined), 0);
});

/* ── stream-log tint ──────────────────────────────────────────────────────── */

test("stream-log level → tint role (error=danger, warn=warn, success=ok, debug=muted)", () => {
  assert.equal(streamLevelRole("error"), "danger");
  assert.equal(streamLevelRole("warn"), "warn");
  assert.equal(streamLevelRole("success"), "ok");
  assert.equal(streamLevelRole("info"), "info");
  assert.equal(streamLevelRole("debug"), "text-secondary");
  assert.equal(streamLevelRole(undefined), "text-secondary");
  assert.equal(streamLevelVar("error"), "var(--danger)");
});

/* ── engine shield — the §5.2 status bar, FAIL-CLOSED ─────────────────────── */

test("shieldTier fails closed: python down / nemesis missing / db absent ⇒ error", () => {
  const ok: EngineProbe = {
    pythonOk: true,
    nemesisPresent: true,
    dbFreshness: "fresh",
    shield: "allow",
  };
  assert.equal(shieldTier(ok), "allow");
  assert.equal(shieldTier({ ...ok, pythonOk: false }), "error");
  assert.equal(shieldTier({ ...ok, nemesisPresent: false }), "error");
  assert.equal(shieldTier({ ...ok, dbFreshness: "absent" }), "error");
  // stale DB downgrades a CLEAN shield to warn (never silently clean).
  assert.equal(shieldTier({ ...ok, dbFreshness: "stale" }), "warn");
  // a real block gate rides through unchanged.
  assert.equal(shieldTier({ ...ok, shield: "block" }), "block");
  // a degraded engine NEVER produces an allow.
  assert.notEqual(shieldTier({ ...ok, pythonOk: false }), "allow");
});

test("engineSummary is a human one-liner of the probe", () => {
  assert.equal(
    engineSummary({ pythonOk: true, nemesisPresent: true, dbFreshness: "fresh" }),
    "python ok · nemesis present · db fresh",
  );
  assert.equal(
    engineSummary({ pythonOk: false, nemesisPresent: false, dbFreshness: "stale" }),
    "python down · nemesis missing · db stale",
  );
});

/* ── formatters + VRAM meter ──────────────────────────────────────────────── */

test("formatBytes / formatCount produce short human strings; garbage ⇒ —", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1_900_000_000), "1.8 GB");
  assert.equal(formatBytes(-1), "—");
  assert.equal(formatBytes(undefined), "—");
  assert.equal(formatCount(410), "410");
  assert.equal(formatCount(1500), "1.5k");
  assert.equal(formatCount(1_200_000), "1.2M");
  assert.equal(formatCount(-1), "—");
});

test("clampFitRatio clamps [0,1] (garbage ⇒ 1, fail toward >budget); fitMeter bands", () => {
  assert.equal(clampFitRatio(0.5), 0.5);
  assert.equal(clampFitRatio(1.4), 1);
  assert.equal(clampFitRatio(-0.2), 0);
  assert.equal(clampFitRatio(undefined), 1);
  assert.equal(clampFitRatio(Number.NaN), 1);
  // explicit engine `fits` wins; an OVERFLOW quant (fits:false) is NEVER ok.
  assert.equal(fitMeterRole(true, 0.99), "ok");
  assert.equal(fitMeterRole(false, 0.1), "danger");
  assert.notEqual(fitMeterRole(false, 0.1), "ok");
  // unknown `fits` bands by headroom.
  assert.equal(fitMeterRole(undefined, 0.5), "ok");
  assert.equal(fitMeterRole(undefined, 0.9), "warn");
  assert.equal(fitMeterRole(undefined, 1.2), "danger");
});

test("meterBar renders a fixed-width block bar clamped to [0,1]", () => {
  assert.equal(meterBar(0, 10), "░░░░░░░░░░");
  assert.equal(meterBar(1, 10), "██████████");
  assert.equal(meterBar(0.5, 10), "█████░░░░░");
  assert.equal(meterBar(2, 10), "██████████"); // clamps
  assert.equal(meterBar(Number.NaN, 4), "░░░░");
});
