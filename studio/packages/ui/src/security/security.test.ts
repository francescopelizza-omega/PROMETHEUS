/**
 * security.test.ts — node:test for the PURE security helpers (file 03 §2.1/§3/
 * §5.3/§8/§9). NO React rendering (there is no DOM here) — this exercises only
 * the dependency-free logic the components lean on:
 *
 *   - stripAnsi / inertText      sanitise untrusted engine strings (§2.1),
 *   - verdictDisplay             the §3 verdict→{color,label,…} selection,
 *   - needsExplicitApproval      the §5.2 warn-gating rule (engine counts only),
 *   - matchesForceToken          the §5.3 exact deep-red token guard,
 *   - purgeNameMatches           the §9.3 exact filename guard,
 *   - disinfectPlan              the §9.1 remediable/quarantine split,
 *   - auditRowMatches/filter     the §8 audit filter predicate.
 *
 * NO-DRIFT PIN: the @prometheus/ui security helpers are LOCAL mirrors of the
 * @prometheus/core verdictMapping/forceToken (ui can't import core — no project
 * reference, the renderer aliases only @prometheus/ui). The dev-resolver DOES map
 * @prometheus/core for this test runner, so we import the REAL core functions and
 * assert the ui mirror agrees with them for every tier/input. If core ever
 * changes, this test fails — keeping the two byte-for-byte in lock-step.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test security.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// REAL core (resolvable in the dev-resolver runner) — the source of truth.
import {
  FORCE_TOKEN as CORE_FORCE_TOKEN,
  matchesForceToken as coreMatchesForceToken,
  needsExplicitApproval as coreNeedsExplicitApproval,
  purgeBasename as corePurgeBasename,
  purgeNameMatches as corePurgeNameMatches,
  verdictDisplay as coreVerdictDisplay,
} from "@prometheus/core";

import type { SecAuditLogEntry, SecFinding, SecVerdictTier } from "./types.js";
import {
  FORCE_TOKEN,
  VERDICT_DISPLAY,
  auditRowMatches,
  disinfectPlan,
  filterAuditRows,
  inertText,
  matchesForceToken,
  needsExplicitApproval,
  purgeBasename,
  purgeNameMatches,
  roleVar,
  stripAnsi,
  verdictDisplay,
} from "./util.js";

const ESC = String.fromCharCode(0x1b);
const ALL_TIERS: SecVerdictTier[] = ["allow", "warn", "block", "error"];

/* ── stripAnsi / inertText (§2.1) ───────────────────────────────────────────*/

test("stripAnsi removes a CSI color sequence, keeps the text", () => {
  assert.equal(stripAnsi(`${ESC}[31mDANGER${ESC}[0m`), "DANGER");
});

test("stripAnsi removes an OSC hyperlink sequence", () => {
  const BEL = String.fromCharCode(0x07);
  assert.equal(stripAnsi(`${ESC}]8;;http://evil${BEL}x`), "x");
});

test("stripAnsi returns '' for a non-string (defensive)", () => {
  assert.equal(stripAnsi(undefined), "");
  assert.equal(stripAnsi(42), "");
});

test("inertText strips bare control chars but keeps TAB and LF", () => {
  const NUL = String.fromCharCode(0x00);
  const TAB = String.fromCharCode(0x09);
  const LF = String.fromCharCode(0x0a);
  assert.equal(inertText(`a${NUL}b${TAB}c${LF}d`), `ab${TAB}c${LF}d`);
});

test("inertText strips ANSI AND control chars together", () => {
  const BS = String.fromCharCode(0x08);
  assert.equal(inertText(`${ESC}[1mhi${BS}`), "hi");
});

/* ── verdictDisplay (§3) — color/label from the mirror, pinned to core ──────*/

test("verdictDisplay maps each tier to the §3 table (color + label)", () => {
  assert.deepEqual(verdictDisplay("allow"), {
    color: "ok",
    label: "SAFE — no known threats found",
    defaultAction: "proceed",
    override: "none",
  });
  assert.deepEqual(verdictDisplay("warn"), {
    color: "warn",
    label: "REVIEW",
    defaultAction: "hold",
    override: "install-anyway",
  });
  assert.deepEqual(verdictDisplay("block"), {
    color: "danger",
    label: "DEEP-RED BLOCK",
    defaultAction: "refuse",
    override: "force",
  });
  assert.deepEqual(verdictDisplay("error"), {
    color: "danger",
    label: "UNVERIFIED",
    defaultAction: "refuse",
    override: "force",
  });
});

test("verdictDisplay agrees with @prometheus/core for every tier (no drift)", () => {
  for (const tier of ALL_TIERS) {
    assert.deepEqual(
      verdictDisplay(tier),
      coreVerdictDisplay(tier),
      `tier ${tier} drifted from core`,
    );
  }
});

test("VERDICT_DISPLAY is frozen (the canonical map can't be mutated)", () => {
  assert.ok(Object.isFrozen(VERDICT_DISPLAY));
  assert.ok(Object.isFrozen(VERDICT_DISPLAY.block));
});

test("verdictDisplay fails CLOSED to UNVERIFIED on a garbage tier (never allow)", () => {
  const d = verdictDisplay("nonsense" as SecVerdictTier);
  assert.equal(d.label, "UNVERIFIED");
  assert.equal(d.color, "danger");
  assert.equal(d.defaultAction, "refuse");
});

test("roleVar maps a color role to its CSS var", () => {
  assert.equal(roleVar("ok"), "var(--ok)");
  assert.equal(roleVar("warn"), "var(--warn)");
  assert.equal(roleVar("danger"), "var(--danger)");
});

/* ── needsExplicitApproval (§5.2) — pinned to core ─────────────────────────*/

test("needsExplicitApproval: block/error always true, allow always false", () => {
  assert.equal(needsExplicitApproval("block", {}), true);
  assert.equal(needsExplicitApproval("error", {}), true);
  assert.equal(needsExplicitApproval("allow", { CRITICAL: 9 }), false);
});

test("needsExplicitApproval: warn gated by CRITICAL/HIGH, MEDIUM only under strict", () => {
  assert.equal(needsExplicitApproval("warn", { LOW: 3 }), false);
  assert.equal(needsExplicitApproval("warn", { HIGH: 1 }), true);
  assert.equal(needsExplicitApproval("warn", { CRITICAL: 1 }), true);
  assert.equal(needsExplicitApproval("warn", { MEDIUM: 2 }), false);
  assert.equal(needsExplicitApproval("warn", { MEDIUM: 2 }, { strict: true }), true);
});

test("needsExplicitApproval agrees with core across tiers/counts (no drift)", () => {
  const cases: Array<[SecVerdictTier, Record<string, number>, boolean]> = [
    ["allow", {}, false],
    ["allow", {}, true],
    ["warn", { LOW: 5 }, false],
    ["warn", { HIGH: 1 }, false],
    ["warn", { MEDIUM: 1 }, false],
    ["warn", { MEDIUM: 1 }, true],
    ["warn", { CRITICAL: 1 }, true],
    ["block", {}, false],
    ["error", { HIGH: 0 }, true],
  ];
  for (const [tier, counts, strict] of cases) {
    assert.equal(
      needsExplicitApproval(tier, counts, { strict }),
      coreNeedsExplicitApproval(tier, counts, { strict }),
      `drift at ${tier} ${JSON.stringify(counts)} strict=${strict}`,
    );
  }
});

/* ── force-token guard (§5.3) — pinned to core ─────────────────────────────*/

test("FORCE_TOKEN is the engine's exact literal and matches core", () => {
  assert.equal(FORCE_TOKEN, "install-dangerous");
  assert.equal(FORCE_TOKEN, CORE_FORCE_TOKEN);
});

test("matchesForceToken: exact match only (no trim, no case-fold)", () => {
  assert.equal(matchesForceToken("install-dangerous"), true);
  assert.equal(matchesForceToken(" install-dangerous"), false);
  assert.equal(matchesForceToken("Install-Dangerous"), false);
  assert.equal(matchesForceToken(""), false);
  assert.equal(matchesForceToken(undefined), false);
});

test("matchesForceToken agrees with core on a spread of inputs", () => {
  for (const input of ["install-dangerous", " install-dangerous", "x", "", "INSTALL-DANGEROUS"]) {
    assert.equal(
      matchesForceToken(input),
      coreMatchesForceToken(input),
      `drift for ${JSON.stringify(input)}`,
    );
  }
});

/* ── purge-name guard (§9.3) — pinned to core ──────────────────────────────*/

test("purgeBasename takes the tail of a path / archive member, agrees with core", () => {
  for (const p of ["server/agent.py", "x.zip!m.bin", "/a/b/c", "bare.py", "dir/", ""]) {
    assert.equal(purgeBasename(p), corePurgeBasename(p), `drift for ${JSON.stringify(p)}`);
  }
});

test("purgeNameMatches: exact basename only; empty/mismatch disabled", () => {
  assert.equal(purgeNameMatches("agent.py", "server/agent.py"), true);
  assert.equal(purgeNameMatches("server/agent.py", "server/agent.py"), false);
  assert.equal(purgeNameMatches("Agent.py", "server/agent.py"), false);
  assert.equal(purgeNameMatches("", ""), false);
  assert.equal(purgeNameMatches(undefined, "x.py"), false);
});

test("purgeNameMatches: byte-exact — NFC vs NFD is a MISMATCH (no Unicode fold, APP-010)", () => {
  // The purge CTA gates on `===`; a différent normalization form is a different
  // byte string, so a NFD echo of an NFC basename must NOT unlock the destroy CTA
  // (main's handler compares the same way — fail toward safety, never coerce).
  const nfc = "résumé.pdf".normalize("NFC");
  const nfd = "résumé.pdf".normalize("NFD");
  assert.notEqual(nfc, nfd, "test premise: the two forms differ byte-wise");
  assert.equal(purgeNameMatches(nfc, `vault/${nfc}`), true); // exact form → enabled
  assert.equal(purgeNameMatches(nfd, `vault/${nfc}`), false); // cross-form → refused
});

test("purgeNameMatches agrees with core", () => {
  const cases: Array<[unknown, string]> = [
    ["agent.py", "server/agent.py"],
    ["m.bin", "x.zip!m.bin"],
    ["wrong", "server/agent.py"],
    [undefined, "x.py"],
  ];
  for (const [typed, file] of cases) {
    assert.equal(
      purgeNameMatches(typed, file),
      corePurgeNameMatches(typed, file),
      `drift for ${JSON.stringify(typed)} / ${file}`,
    );
  }
});

/* ── disinfectPlan (§9.1) ───────────────────────────────────────────────────*/

function finding(rule_id: string, remediable: boolean): SecFinding {
  return {
    rule_id,
    severity: "HIGH",
    klass: "secret",
    path: `p/${rule_id}`,
    detail: "d",
    remediable,
  };
}

test("disinfectPlan splits on the engine's remediable flag, preserving order", () => {
  const fs = [finding("a", true), finding("b", false), finding("c", true)];
  const plan = disinfectPlan(fs);
  assert.deepEqual(
    plan.remediable.map((f) => f.rule_id),
    ["a", "c"],
  );
  assert.deepEqual(
    plan.quarantineOnly.map((f) => f.rule_id),
    ["b"],
  );
});

test("disinfectPlan tolerates an empty / undefined list", () => {
  assert.deepEqual(disinfectPlan([]), { remediable: [], quarantineOnly: [] });
});

/* ── audit filter (§8) ──────────────────────────────────────────────────────*/

function row(partial: Partial<SecAuditLogEntry>): SecAuditLogEntry {
  return {
    at: "2026-06-15T12:00:00.000Z",
    label: "l",
    target: "t",
    verdict: "allow",
    risk_score: 0,
    blocking_reasons: [],
    decision: null,
    tier: "allow",
    ...partial,
  };
}

test("auditRowMatches: empty filter passes everything", () => {
  assert.equal(auditRowMatches(row({}), {}), true);
});

test("auditRowMatches: forcedOnly keeps forced/dangerous decisions", () => {
  assert.equal(auditRowMatches(row({ decision: "forced-danger" }), { forcedOnly: true }), true);
  assert.equal(auditRowMatches(row({ decision: "proceed" }), { forcedOnly: true }), false);
});

test("auditRowMatches: blocksOnly keeps block/error tiers", () => {
  assert.equal(auditRowMatches(row({ tier: "block" }), { blocksOnly: true }), true);
  assert.equal(auditRowMatches(row({ tier: "error" }), { blocksOnly: true }), true);
  assert.equal(auditRowMatches(row({ tier: "allow" }), { blocksOnly: true }), false);
});

test("auditRowMatches: last24h keeps recent, drops old + unparseable", () => {
  const now = Date.parse("2026-06-15T12:00:00.000Z");
  assert.equal(
    auditRowMatches(row({ at: "2026-06-15T11:00:00.000Z" }), { last24h: true }, now),
    true,
  );
  assert.equal(
    auditRowMatches(row({ at: "2026-06-10T11:00:00.000Z" }), { last24h: true }, now),
    false,
  );
  assert.equal(auditRowMatches(row({ at: "not-a-date" }), { last24h: true }, now), false);
});

test("filterAuditRows applies the predicate over a list", () => {
  const rows = [row({ tier: "allow" }), row({ tier: "block" }), row({ tier: "error" })];
  assert.equal(filterAuditRows(rows, { blocksOnly: true }).length, 2);
  assert.equal(filterAuditRows(rows, {}).length, 3);
});
