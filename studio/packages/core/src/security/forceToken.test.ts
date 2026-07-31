/**
 * forceToken.test.ts — node:test for the deep-red override token + purge guard.
 *
 * Pins:
 *   - FORCE_TOKEN is the engine's EXACT literal "install-dangerous",
 *   - matchesForceToken is exact-compare only (true/false; no trim/case-fold),
 *   - purgeBasename extracts the filename from a path / in-archive member,
 *   - purgeNameMatches enables the irreversible Purge CTA ONLY on an exact
 *     basename match (fail toward safety on mismatch / empty / non-string).
 *
 * Run: node --import ../../../../apps/cli/dev-register.mjs --test forceToken.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FORCE_TOKEN, matchesForceToken, purgeBasename, purgeNameMatches } from "./forceToken.js";

/* ── the token is byte-identical to the engine's ───────────────────────────*/

test("FORCE_TOKEN is the engine's exact literal", () => {
  assert.equal(FORCE_TOKEN, "install-dangerous");
});

/* ── matchesForceToken: exact match true / false ───────────────────────────*/

test("matchesForceToken returns true ONLY for the exact token", () => {
  assert.equal(matchesForceToken("install-dangerous"), true);
});

test("matchesForceToken rejects near-misses, case, whitespace, non-strings", () => {
  for (const bad of [
    "Install-Dangerous",
    "INSTALL-DANGEROUS",
    " install-dangerous",
    "install-dangerous ",
    "install_dangerous",
    "install-dangerou",
    "install-dangerouss",
    "",
    "yes",
    undefined,
    null,
    42,
    {},
    ["install-dangerous"],
  ]) {
    assert.equal(matchesForceToken(bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});

/* ── purgeBasename ─────────────────────────────────────────────────────────*/

test("purgeBasename extracts the file name from a path", () => {
  assert.equal(purgeBasename("server/agent.py"), "agent.py");
  assert.equal(purgeBasename("/abs/path/to/x.bin"), "x.bin");
  assert.equal(purgeBasename("flat.py"), "flat.py");
  assert.equal(purgeBasename("C:\\\\win\\\\path\\\\evil.dll"), "evil.dll");
});

test("purgeBasename keeps the in-archive member tail", () => {
  // an in-archive member "pkg.zip!sub/x.bin" → the deepest segment "x.bin".
  assert.equal(purgeBasename("vendor.zip!x.bin"), "vendor.zip!x.bin");
  assert.equal(purgeBasename("vendor.zip!sub/x.bin"), "x.bin");
});

test("purgeBasename strips a trailing slash (directory path)", () => {
  assert.equal(purgeBasename("some/dir/"), "dir");
  assert.equal(purgeBasename(""), "");
});

/* ── purgeNameMatches: exact basename match enables the CTA ─────────────────*/

test("purgeNameMatches enables the CTA only on an exact basename match", () => {
  assert.equal(purgeNameMatches("agent.py", "server/agent.py"), true);
  assert.equal(purgeNameMatches("agent.py", "agent.py"), true);
});

test("purgeNameMatches rejects the full path, a mismatch, case, and non-strings", () => {
  assert.equal(purgeNameMatches("server/agent.py", "server/agent.py"), false); // must type basename
  assert.equal(purgeNameMatches("Agent.py", "server/agent.py"), false); // case-sensitive
  assert.equal(purgeNameMatches("agent.pyc", "server/agent.py"), false);
  assert.equal(purgeNameMatches(undefined, "server/agent.py"), false);
  assert.equal(purgeNameMatches(123, "server/agent.py"), false);
});

test("purgeNameMatches fails closed when there is nothing to confirm against", () => {
  // empty filename ⇒ never enable (an empty typed must not match an empty expected).
  assert.equal(purgeNameMatches("", ""), false);
  assert.equal(purgeNameMatches("anything", ""), false);
});
