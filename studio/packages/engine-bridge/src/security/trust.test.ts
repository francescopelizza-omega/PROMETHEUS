/**
 * trust.test.ts — CLI-079: the extended gate-audit filters (target/since/until/rule) + auditBounds.
 * Drives the pure `auditLog(filter, filePath)` over a temp JSONL fixture (fail-soft, newest-first).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type AuditLogEntry, auditBounds, auditLog } from "./trust.js";

function writeLog(entries: Partial<AuditLogEntry>[]): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "prom-audit-"));
  const path = join(dir, "gate-audit.jsonl");
  writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return { path, dir };
}

const ROWS: Partial<AuditLogEntry>[] = [
  {
    at: "2026-07-01T10:00:00Z",
    target: "github.com/a/repo",
    verdict: "allow",
    blocking_reasons: [],
  },
  {
    at: "2026-07-03T10:00:00Z",
    target: "github.com/b/evil",
    verdict: "block",
    blocking_reasons: ["S1.curl_pipe_sh"],
    decision: "proceed-forced-danger",
  },
  {
    at: "2026-07-05T10:00:00Z",
    target: "pypi/pkg",
    verdict: "warn",
    blocking_reasons: [],
    verdict_full: { findings: [{ rule_id: "R99.telemetry" }] },
  },
];

function withLog(fn: (path: string) => void): void {
  const { path, dir } = writeLog(ROWS);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI-079 --target: case-sensitive substring against entry.target", () => {
  withLog((p) => {
    assert.deepEqual(
      auditLog({ target: "evil" }, p).map((r) => r.target),
      ["github.com/b/evil"],
    );
    assert.equal(auditLog({ target: "EVIL" }, p).length, 0); // case-sensitive
    assert.equal(auditLog({ target: "github.com" }, p).length, 2);
  });
});

test("CLI-079 --since / --until: inclusive bounds (bare date = UTC; until = end-of-day)", () => {
  withLog((p) => {
    // >= 2026-07-03 → block + warn (newest-first).
    assert.deepEqual(
      auditLog({ since: "2026-07-03" }, p).map((r) => r.verdict),
      ["warn", "block"],
    );
    // <= 2026-07-03 end-of-day → the 07-03 10:00 row IS included (inclusive), plus 07-01.
    assert.deepEqual(
      auditLog({ until: "2026-07-03" }, p).map((r) => r.verdict),
      ["block", "allow"],
    );
    // exact single-day range → only the 07-03 row.
    assert.deepEqual(
      auditLog({ since: "2026-07-03", until: "2026-07-03" }, p).map((r) => r.verdict),
      ["block"],
    );
  });
});

test("CLI-079 --rule: matches blocking_reasons AND a verdict_full rule id", () => {
  withLog((p) => {
    assert.deepEqual(
      auditLog({ rule: "curl_pipe_sh" }, p).map((r) => r.verdict),
      ["block"],
    );
    assert.deepEqual(
      auditLog({ rule: "R99.telemetry" }, p).map((r) => r.verdict),
      ["warn"], // matched inside verdict_full, not blocking_reasons
    );
  });
});

test("CLI-079 filters compose (AND) with each other + the existing booleans", () => {
  withLog((p) => {
    // blocks + since → only the 07-03 block row.
    assert.deepEqual(
      auditLog({ blocks: true, since: "2026-07-02" }, p).map((r) => r.verdict),
      ["block"],
    );
    // target + until → the 07-01 allow row (github + on/before 07-02).
    assert.deepEqual(
      auditLog({ target: "github", until: "2026-07-02" }, p).map((r) => r.verdict),
      ["allow"],
    );
  });
});

test("CLI-079 --last24h intersects --since (most-restrictive 24h floor still applies)", () => {
  withLog((p) => {
    // all fixture rows are in the (relative) past → the 24h floor excludes them even with a wide since.
    assert.equal(auditLog({ last24h: true, since: "2000-01-01" }, p).length, 0);
  });
});

test("CLI-079 fail-soft: a malformed date is 'no bound', never a throw (missing file ⇒ [])", () => {
  withLog((p) => {
    assert.equal(auditLog({ since: "not-a-date" }, p).length, 3); // bad bound ignored → all rows
    assert.equal(auditLog({ until: "garbage" }, p).length, 3);
  });
  assert.deepEqual(auditLog({ target: "x" }, "/no/such/audit/file.jsonl"), []); // never throws
});

test("CLI-079 auditBounds resolves since/until to epoch ms (invalid ⇒ null)", () => {
  const b = auditBounds({ since: "2026-07-03", until: "2026-07-03" });
  assert.equal(b.sinceMs, Date.parse("2026-07-03T00:00:00Z"));
  assert.equal(b.untilMs, Date.parse("2026-07-03T23:59:59.999Z"));
  assert.deepEqual(auditBounds({ since: "bad" }), { sinceMs: null, untilMs: null });
  assert.deepEqual(auditBounds({}), { sinceMs: null, untilMs: null });
});
