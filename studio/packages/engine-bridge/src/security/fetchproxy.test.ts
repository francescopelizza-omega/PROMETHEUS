import assert from "node:assert/strict";
/**
 * fetchproxy.test.ts — L6 safe-fetch proxy bridge (url_injection_safeguard.md §3).
 *  - check/fetch fail closed on a loopback URL (SSRF guard in the python sidecar).
 *  - web content is always DATA: provenance.executable === false, blocked → data:null.
 *  - a missing sidecar dir → blocked result, never a throw.
 * Runs the real python sidecar; skips gracefully if python3 is unavailable.
 */
import { test } from "node:test";

import { cloakProbe, safeFetch, safeFetchCheck } from "./fetchproxy.js";

test("FAIL-CLOSED: check() on a loopback URL is not safe", async () => {
  const r = await safeFetchCheck("http://127.0.0.1/secret");
  assert.equal(r.command, "check");
  assert.equal(r.safe, false);
});

test("FAIL-CLOSED: fetch() on a loopback URL is blocked + data is null", async () => {
  const r = await safeFetch("http://127.0.0.1/secret");
  assert.equal(r.blocked, true);
  assert.equal(r.verdict, "block");
  assert.equal(r.data, null);
  // web is DATA, never code — even a blocked result asserts non-executable
  assert.equal(r.provenance.executable, false);
});

test("FAIL-CLOSED: non-http scheme is blocked", async () => {
  const r = await safeFetch("file:///etc/passwd");
  assert.equal(r.blocked, true);
  assert.equal(r.data, null);
});

test("FAIL-CLOSED: a missing sidecar dir yields a blocked result, no throw", async () => {
  const r = await safeFetch("https://example.com/", {
    sidecar: { sidecarDir: "/nonexistent/sidecar/dir/xyz" },
  });
  assert.equal(r.blocked, true);
  assert.equal(r.verdict, "block");
  assert.equal(r.provenance.executable, false);
});

test("FAIL-CLOSED: cloakProbe on a dead sidecar is risk-positive (cloaked:true)", async () => {
  const r = await cloakProbe("https://example.com/", {
    sidecar: { sidecarDir: "/nonexistent/sidecar/dir/xyz" },
  });
  assert.equal(r.cloaked, true);
  assert.equal(r.command, "probe");
  assert.ok(r.signals.length >= 1);
});

test("cloakProbe on a loopback URL returns a probe verdict, no throw", async () => {
  const r = await cloakProbe("http://127.0.0.1/x");
  assert.equal(r.command, "probe");
  // both personas SSRF-blocked → not cloaked (consistently blocked), verdict allow
  assert.equal(typeof r.cloaked, "boolean");
});
