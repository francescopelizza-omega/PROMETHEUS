/**
 * gate.test.ts — node:test for the RUN-GATE (file 07 §5.2/§9, C4/C5).
 *
 * The GOLDEN RULE made concrete: JS never decides "safe". This pins:
 *   - TRUSTED at HEAD → ALLOW, NO fresh scan ran (the F5 re-prompt is skipped),
 *   - UNTRUSTED → the REAL engine-bridge gate runs and its verdict is RENDERED
 *     (allow→allow, warn→warn, block/error→block),
 *   - FAIL-CLOSED: a gate that returns verdict "error" (a missing/timed-out/
 *     unparseable nemesis, which engine-bridge already collapses to "error") → BLOCK,
 *   - hasTrustedVerdict matching: a clean entry pinned to HEAD matches; a blocking
 *     trust token never matches; an unknown HEAD never matches.
 *
 * The engine gate is INJECTED (`runGate` stub) so we test the routing/decision
 * logic deterministically without spawning nemesis — AND a fail-closed case feeds
 * the kind of "error" verdict engine-bridge produces on a bad scanner. A SEPARATE
 * path (gate() itself) is exercised LIVE elsewhere; here we pin the decision math.
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test gate.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SecurityVerdict, TrustedSource } from "@prometheus/engine-bridge";

import { hasTrustedVerdict, runGate } from "./gate.js";

const HEAD = "a".repeat(40);

/** Build a SecurityVerdict of a given tier. */
function verdict(tier: SecurityVerdict["verdict"], findings = 0): SecurityVerdict {
  return {
    verdict: tier,
    risk_score: tier === "allow" ? 0 : tier === "warn" ? 50 : 100,
    signed: false,
    findings: Array.from({ length: findings }, (_, i) => ({
      klass: "malware",
      severity: "high",
      rule: `R-${i}`,
      where: `f${i}`,
    })),
    scannedAt: new Date().toISOString(),
    target: "/ws",
  };
}

/* ── hasTrustedVerdict matching ──────────────────────────────────────────────*/

test("hasTrustedVerdict matches a CLEAN entry pinned to the current HEAD", () => {
  const trusted: TrustedSource[] = [
    {
      key: `ws@editor#git:${HEAD}`,
      name: "ws",
      agent: "editor",
      ident: `git:${HEAD}`,
      verdict: "allow",
    },
  ];
  const match = hasTrustedVerdict({ workspaceRoot: "/proj/ws", head: HEAD }, trusted);
  assert.ok(match, "a clean HEAD-pinned entry is trusted");
});

test("hasTrustedVerdict refuses a BLOCKING trust token (never auto-trusts)", () => {
  const trusted: TrustedSource[] = [
    { key: `ws@editor#${HEAD}`, name: "ws", agent: "editor", ident: HEAD, verdict: "block" },
  ];
  assert.equal(hasTrustedVerdict({ workspaceRoot: "/proj/ws", head: HEAD }, trusted), undefined);
});

test("hasTrustedVerdict never matches when HEAD is unknown (non-repo) → re-scan", () => {
  const trusted: TrustedSource[] = [
    { key: `ws@editor#${HEAD}`, name: "ws", agent: "editor", ident: HEAD, verdict: "allow" },
  ];
  assert.equal(hasTrustedVerdict({ workspaceRoot: "/proj/ws" }, trusted), undefined);
});

test("hasTrustedVerdict never matches a DIFFERENT HEAD (tree changed → re-scan)", () => {
  const trusted: TrustedSource[] = [
    { key: `ws@editor#${HEAD}`, name: "ws", agent: "editor", ident: HEAD, verdict: "allow" },
  ];
  assert.equal(
    hasTrustedVerdict({ workspaceRoot: "/proj/ws", head: "b".repeat(40) }, trusted),
    undefined,
  );
});

/* ── runGate decision routing ────────────────────────────────────────────────*/

test("runGate: TRUSTED at HEAD → ALLOW, no fresh scan ran", async () => {
  let scanned = false;
  const res = await runGate(
    { workspaceRoot: "/proj/ws", head: HEAD },
    {
      readTrusted: () => [
        {
          key: `ws@editor#git:${HEAD}`,
          name: "ws",
          agent: "editor",
          ident: `git:${HEAD}`,
          verdict: "allow",
        },
      ],
      runGate: async () => {
        scanned = true;
        return verdict("block");
      },
    },
  );
  assert.equal(res.decision, "allow");
  assert.equal(res.mayLaunch, true);
  assert.equal(res.trusted, true);
  assert.equal(scanned, false, "a trusted workspace is NOT re-scanned");
});

test("runGate: UNTRUSTED + allow verdict → ALLOW (fresh scan ran)", async () => {
  const res = await runGate(
    { workspaceRoot: "/proj/ws", head: HEAD },
    { readTrusted: () => [], runGate: async () => verdict("allow") },
  );
  assert.equal(res.decision, "allow");
  assert.equal(res.mayLaunch, true);
  assert.equal(res.trusted, false);
  assert.equal(res.verdict?.verdict, "allow");
});

test("runGate: UNTRUSTED + warn verdict → WARN (renderer shows 'Run anyway?')", async () => {
  const res = await runGate(
    { workspaceRoot: "/proj/ws", head: HEAD },
    { readTrusted: () => [], runGate: async () => verdict("warn", 2) },
  );
  assert.equal(res.decision, "warn");
  assert.equal(res.mayLaunch, false, "warn does NOT auto-launch — the modal defaults NO");
  assert.equal(res.findingsCount, undefined); // findingsCount is on the IPC mapping, not gate.ts
  assert.match(res.reason, /warn/);
});

test("runGate: UNTRUSTED + block verdict → BLOCK (launch refused)", async () => {
  const res = await runGate(
    { workspaceRoot: "/proj/ws", head: HEAD },
    { readTrusted: () => [], runGate: async () => verdict("block", 3) },
  );
  assert.equal(res.decision, "block");
  assert.equal(res.mayLaunch, false);
  assert.match(res.reason, /launch refused/);
});

test("runGate: FAIL-CLOSED — an 'error' verdict (bad nemesis) → BLOCK", async () => {
  // engine-bridge gate() collapses a missing/timed-out/unparseable scanner to
  // verdict "error"; the run-gate must treat that as BLOCK, never allow.
  const res = await runGate(
    { workspaceRoot: "/proj/ws", head: HEAD },
    { readTrusted: () => [], runGate: async () => verdict("error", 1) },
  );
  assert.equal(res.decision, "block");
  assert.equal(res.mayLaunch, false);
});

test("runGate: a gate that THROWS still fails closed to BLOCK", async () => {
  const res = await runGate(
    { workspaceRoot: "/proj/ws", head: HEAD },
    {
      readTrusted: () => [],
      runGate: async () => {
        throw new Error("nemesis spawn exploded");
      },
    },
  );
  assert.equal(res.decision, "block");
  assert.equal(res.mayLaunch, false);
  assert.match(res.reason, /gate crashed/);
});

test("runGate: an empty workspace root fails closed to BLOCK", async () => {
  const res = await runGate(
    { workspaceRoot: "" },
    { readTrusted: () => [], runGate: async () => verdict("allow") },
  );
  assert.equal(res.decision, "block");
  assert.equal(res.mayLaunch, false);
});

test("runGate: a broken trust read does NOT allow — falls through to a fresh scan", async () => {
  let scanned = false;
  const res = await runGate(
    { workspaceRoot: "/proj/ws", head: HEAD },
    {
      readTrusted: () => {
        throw new Error("trust.json corrupt");
      },
      runGate: async () => {
        scanned = true;
        return verdict("allow");
      },
    },
  );
  assert.equal(scanned, true, "a broken trust read must re-scan, never assume trusted");
  assert.equal(res.decision, "allow");
  assert.equal(res.trusted, false);
});
