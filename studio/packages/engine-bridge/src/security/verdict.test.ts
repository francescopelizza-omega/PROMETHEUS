import assert from "node:assert/strict";
/**
 * verdict.test.ts — the verdict-tier mapping unit test (no subprocess).
 * Pure functions: exit-code -> tier, verdict normalisation, severity, klass,
 * blocking classification. node:test + node:assert only.
 */
import { test } from "node:test";

import {
  isBlockingTier,
  normalizeKlass,
  normalizeSeverity,
  normalizeVerdict,
  tierFromExitCode,
} from "./verdict.js";

test("tierFromExitCode maps nemesis decision codes 0/10/20/2", () => {
  assert.equal(tierFromExitCode(0), "allow");
  assert.equal(tierFromExitCode(10), "warn");
  assert.equal(tierFromExitCode(20), "block");
  assert.equal(tierFromExitCode(2), "error");
});

test("tierFromExitCode fails closed on unknown/null codes", () => {
  assert.equal(tierFromExitCode(1), "error");
  assert.equal(tierFromExitCode(137), "error");
  assert.equal(tierFromExitCode(null), "error");
  assert.equal(tierFromExitCode(undefined), "error");
  assert.equal(tierFromExitCode(-1), "error");
});

test("normalizeVerdict canonicalises and fails closed", () => {
  assert.equal(normalizeVerdict("allow"), "allow");
  assert.equal(normalizeVerdict("WARN"), "warn");
  assert.equal(normalizeVerdict(" Block "), "block");
  assert.equal(normalizeVerdict("error"), "error");
  // anything unexpected => fail closed
  assert.equal(normalizeVerdict("safe"), "error");
  assert.equal(normalizeVerdict(undefined), "error");
  assert.equal(normalizeVerdict(42), "error");
});

test("normalizeSeverity maps nemesis severity tokens; clean is a severity", () => {
  assert.equal(normalizeSeverity("CRITICAL"), "critical");
  assert.equal(normalizeSeverity("High"), "high");
  assert.equal(normalizeSeverity("medium"), "medium");
  assert.equal(normalizeSeverity("LOW"), "low");
  assert.equal(normalizeSeverity("INFO"), "clean");
  assert.equal(normalizeSeverity(""), "clean");
  // unknown severity is still a finding => low (never clean)
  assert.equal(normalizeSeverity("weird"), "low");
});

test("normalizeKlass buckets finding classes; unknown => malware (conservative)", () => {
  assert.equal(normalizeKlass("malware"), "malware");
  assert.equal(normalizeKlass("secret"), "secret");
  assert.equal(normalizeKlass("vuln"), "vuln");
  assert.equal(normalizeKlass("vulnerability"), "vuln");
  assert.equal(normalizeKlass("sca"), "sca");
  assert.equal(normalizeKlass("supply_chain"), "sca");
  assert.equal(normalizeKlass("dropper"), "malware");
  assert.equal(normalizeKlass(undefined), "malware");
});

test("isBlockingTier: block & error halt; allow & warn do not", () => {
  assert.equal(isBlockingTier("allow"), false);
  assert.equal(isBlockingTier("warn"), false);
  assert.equal(isBlockingTier("block"), true);
  assert.equal(isBlockingTier("error"), true);
});
