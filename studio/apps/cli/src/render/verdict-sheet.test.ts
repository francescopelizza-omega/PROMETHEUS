/**
 * verdict-sheet.test.ts — node:test unit tests for the P3 verdict-sheet projector.
 *
 * Deterministic & dependency-free: color is disabled via setColorEnabled(false)
 * so assertions match plain text (no ANSI escapes). Imports from source so the
 * suite runs under Node's native type-stripping (node --test src/...).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SecurityVerdict } from "@prometheus/engine-bridge";

import { setColorEnabled } from "../render.js";
import { renderVerdictSheet } from "./verdict-sheet.js";

// Render plain text everywhere — no ANSI escapes to fight in assertions.
setColorEnabled(false);

function verdict(over: Partial<SecurityVerdict> = {}): SecurityVerdict {
  return {
    verdict: "allow",
    risk_score: 0,
    signed: true,
    findings: [],
    scannedAt: "2026-06-22T00:00:00Z",
    target: "github.com/acme/widget",
    ...over,
  };
}

test("allow verdict: shows ALLOW label, headline, no override affordance", () => {
  const out = renderVerdictSheet(verdict());
  assert.match(out, /ALLOW/);
  assert.match(out, /Safe to install \/ run \/ use\./);
  assert.match(out, /github\.com\/acme\/widget/);
  // No findings, no override block.
  assert.match(out, /No findings\./);
  assert.doesNotMatch(out, /DANGEROUS override/);
  assert.doesNotMatch(out, /--force/);
});

test("gate badge line summarizes decision, risk, signed, findings", () => {
  const out = renderVerdictSheet(verdict({ verdict: "warn", risk_score: 42, signed: false }));
  assert.match(out, /gate:/);
  assert.match(out, /WARN/);
  assert.match(out, /risk 42/);
  assert.match(out, /unsigned/);
});

test("badge counts findings with correct singular/plural", () => {
  const one = renderVerdictSheet(
    verdict({
      verdict: "warn",
      findings: [{ klass: "secret", severity: "medium", rule: "aws-key", where: "src/x.ts" }],
    }),
  );
  assert.match(one, /1 finding\b/);
  assert.doesNotMatch(one, /1 findings/);

  const two = renderVerdictSheet(
    verdict({
      verdict: "warn",
      findings: [
        { klass: "secret", severity: "medium", rule: "aws-key", where: "a.ts" },
        { klass: "vuln", severity: "high", rule: "cve-1", where: "b.ts" },
      ],
    }),
  );
  assert.match(two, /2 findings/);
});

test("hideBadge omits the gate badge line", () => {
  const out = renderVerdictSheet(verdict(), { hideBadge: true });
  assert.doesNotMatch(out, /^gate:/m);
});

test("block verdict surfaces a typed-confirm override affordance honoring the action", () => {
  const out = renderVerdictSheet(verdict({ verdict: "block", risk_score: 88 }), {
    action: "install",
  });
  assert.match(out, /BLOCK/);
  assert.match(out, /DANGEROUS override/);
  assert.match(out, /To install anyway/);
  assert.match(out, /--force/);
  assert.match(out, /OVERRIDE BLOCK/);
  // The engine still re-decides — JS grants nothing.
  assert.match(out, /nothing here grants permission/);
});

test("error verdict uses the stronger 'I ACCEPT THE RISK' phrase", () => {
  const out = renderVerdictSheet(verdict({ verdict: "error", risk_score: 100 }), {
    action: "run",
  });
  assert.match(out, /ERROR/);
  assert.match(out, /I ACCEPT THE RISK/);
  assert.match(out, /To run anyway/);
});

test("forbidForce replaces the override affordance with a hard forbidden line", () => {
  const out = renderVerdictSheet(verdict({ verdict: "block" }), {
    action: "install",
    forbidForce: true,
  });
  assert.match(out, /forbidden by the active profile/);
  assert.match(out, /No bypass available|no bypass available/i);
  // The opt-in path must NOT be advertised when force is forbidden.
  assert.doesNotMatch(out, /pass --force/);
});

test("non-blocking tiers never show an override affordance", () => {
  for (const tier of ["allow", "warn"] as const) {
    const out = renderVerdictSheet(verdict({ verdict: tier }));
    assert.doesNotMatch(out, /DANGEROUS override/, `tier=${tier} must not offer override`);
    assert.doesNotMatch(out, /forbidden by the active profile/, `tier=${tier}`);
  }
});

test("forced-danger recap lists overridden labels and blocking reasons", () => {
  const out = renderVerdictSheet(verdict({ verdict: "block" }), {
    forced: [
      {
        label: "github.com/acme/widget",
        verdict: "block",
        risk_score: 88,
        blocking_reasons: ["malware:eicar", "secret:aws-key"],
      },
    ],
  });
  assert.match(out, /OVERRIDE APPLIED/);
  assert.match(out, /github\.com\/acme\/widget/);
  assert.match(out, /risk 88/);
  assert.match(out, /malware:eicar/);
  assert.match(out, /secret:aws-key/);
});

test("findings table from verdict-view is reused (severity + rule + where shown)", () => {
  const out = renderVerdictSheet(
    verdict({
      verdict: "block",
      risk_score: 90,
      findings: [{ klass: "malware", severity: "critical", rule: "eicar", where: "payload.sh" }],
    }),
  );
  assert.match(out, /findings \(1\)/);
  assert.match(out, /CRITICAL/);
  assert.match(out, /malware/);
  assert.match(out, /eicar/);
  assert.match(out, /payload\.sh/);
});

test("output is a single trimmed string with no trailing newline", () => {
  const out = renderVerdictSheet(verdict());
  assert.equal(typeof out, "string");
  assert.ok(!out.endsWith("\n"), "must not end with a trailing newline");
  assert.ok(out.length > 0);
});

test("width is clamped to a safe range (no crash on extreme values)", () => {
  assert.doesNotThrow(() => renderVerdictSheet(verdict(), { width: 0 }));
  assert.doesNotThrow(() => renderVerdictSheet(verdict(), { width: 9999 }));
});
