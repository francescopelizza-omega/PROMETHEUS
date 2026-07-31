/**
 * permission-audit.test.ts — the bypassPermissions audit trail (CLI-033): one line per
 * auto-approval, atomic-appendable, fail-soft; argv summarization.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendPermissionAudit, argvSummaryOf, permissionAuditPath } from "./permission-audit.js";

test("appendPermissionAudit writes one line per call; survives a fresh read", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-audit-"));
  try {
    appendPermissionAudit(
      "prometheus_install",
      { name: "nmap", argv: ["--yes"] },
      "auto-approved",
      home,
      () => "2026-07-17T00:00:00.000Z",
    );
    appendPermissionAudit(
      "prometheus_list",
      {},
      "auto-approved",
      home,
      () => "2026-07-17T00:00:01.000Z",
    );
    const log = readFileSync(permissionAuditPath(home), "utf8");
    const lines = log.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /prometheus_install \| name=nmap argv=--yes \| auto-approved/);
    assert.match(lines[1] ?? "", /2026-07-17T00:00:01\.000Z \| prometheus_list/);
    // lexicographic sort == chronological (ISO Z timestamps).
    assert.deepEqual([...lines].sort(), lines);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("argvSummaryOf compacts args + skips null/undefined", () => {
  assert.equal(argvSummaryOf({ name: "x", flag: true, skip: null }), "name=x flag=true");
  assert.equal(argvSummaryOf({}), "");
});

test("appendPermissionAudit is fail-soft on an unwritable home (no throw)", () => {
  assert.doesNotThrow(() =>
    appendPermissionAudit(
      "t",
      {},
      "auto-approved",
      "/no/such/root/xyz",
      () => "2026-07-17T00:00:00Z",
    ),
  );
});
