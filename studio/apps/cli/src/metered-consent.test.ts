/**
 * metered-consent.test.ts — the CLI "ENABLE METERED" consent receipt (CLI-031):
 * strict phrase matching + per-provider persistence that survives a fresh read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ENABLE_METERED_PHRASE,
  grantMeteredConsent,
  hasMeteredConsent,
  isEnableMeteredPhrase,
  readMeteredConsent,
} from "./metered-consent.js";

test("isEnableMeteredPhrase: exact match only (no trim, case-sensitive)", () => {
  assert.equal(isEnableMeteredPhrase("ENABLE METERED"), true);
  assert.equal(isEnableMeteredPhrase("ENABLE METERED\n"), true); // trailing newline stripped
  assert.equal(isEnableMeteredPhrase("ENABLE METERED\r\n"), true); // CRLF stripped
  assert.equal(isEnableMeteredPhrase("enable metered"), false); // case
  assert.equal(isEnableMeteredPhrase(" ENABLE METERED"), false); // leading space NOT trimmed
  assert.equal(isEnableMeteredPhrase("ENABLE METERED "), false); // trailing space NOT trimmed
  assert.equal(isEnableMeteredPhrase("ENABLE"), false); // partial
  assert.equal(ENABLE_METERED_PHRASE, "ENABLE METERED");
});

test("grant → has → read persists per provider + survives a fresh read (restart)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-consent-"));
  try {
    assert.equal(hasMeteredConsent("groq", home), false);
    grantMeteredConsent("groq", "2026-07-17T00:00:00.000Z", home);
    // a FRESH read (no shared instance) sees it — persisted to disk.
    assert.equal(hasMeteredConsent("groq", home), true);
    assert.equal(hasMeteredConsent("openrouter", home), false); // per-provider
    assert.equal(readMeteredConsent(home).groq, "2026-07-17T00:00:00.000Z");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readMeteredConsent: missing/garbage settings → {} (fail-soft, never auto-grant)", () => {
  assert.deepEqual(readMeteredConsent("/no/such/home/xyz"), {});
});
