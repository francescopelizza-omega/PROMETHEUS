/**
 * exec-gate.test.ts — the nemesis layer + the audit trail (Phase 3).
 *
 * Two acceptance criteria, both pinned here:
 *   1. **A BLOCKed command aborts at A7.** The ladder governs how often a human is asked; it
 *      never governs whether the scanner is obeyed.
 *   2. **Every run appears in the audit log** — including the ones nobody was asked about,
 *      which are the ones an audit exists for.
 *
 * The scanner is INJECTED. Nothing here spawns nemesis.
 */
import assert from "node:assert/strict";
import assertStrict from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import type { SecurityVerdict } from "@prometheus/engine-bridge";

import {
  type ExecAuditEntry,
  appendExecAudit,
  execAuditEntry,
  execAuditPath,
  resetScanCache,
  scanCommand,
  verdictBlocks,
} from "./exec-gate.js";
import { runSystemTool } from "./system-tools.js";

beforeEach(() => resetScanCache());

function verdict(v: SecurityVerdict["verdict"], reasons: string[] = []): SecurityVerdict {
  return {
    verdict: v,
    risk_score: v === "allow" ? 0 : v === "warn" ? 50 : 100,
    signed: false,
    findings: reasons.map((r) => ({
      klass: "malware" as const,
      severity: "high" as const,
      rule: "nemesis",
      where: r,
    })),
    scannedAt: new Date().toISOString(),
    target: "command",
  };
}

/** A spawn fake that records whether it ever ran. */
function watchSpawn() {
  const state = { spawned: false };
  const spawnImpl = (_c: string, _a: string[], _o: Record<string, unknown>) => {
    state.spawned = true;
    const closeCbs: ((code?: unknown) => void)[] = [];
    queueMicrotask(() => {
      for (const cb of closeCbs) cb(0);
    });
    return {
      pid: undefined,
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: { end: () => {}, write: () => {} },
      on: (e: string, cb: (a?: unknown) => void) => {
        if (e === "close") closeCbs.push(cb);
      },
      kill: () => {},
    };
  };
  return { state, spawnImpl };
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "prom-exec-audit-"));
}

function readAudit(home: string): ExecAuditEntry[] {
  return readFileSync(execAuditPath(home), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ExecAuditEntry);
}

/* ── verdictBlocks: the rule the whole layer rests on ────────────────────────*/

test("`block` stops the command; `error` stops it under enforce", () => {
  assert.equal(verdictBlocks(verdict("block"), "enforce"), true);
  assert.equal(verdictBlocks(verdict("error"), "enforce"), true);
  assert.equal(verdictBlocks(verdict("warn"), "enforce"), false);
  assert.equal(verdictBlocks(verdict("allow"), "enforce"), false);
});

test("`warn` mode tolerates an unreadable verdict but still stops a BLOCK", () => {
  // `error` means "we could not get a trustworthy answer". Under `warn` the operator has
  // accepted that risk; under `enforce` it behaves exactly like "the answer was no".
  assert.equal(verdictBlocks(verdict("error"), "warn"), false);
  assert.equal(verdictBlocks(verdict("block"), "warn"), true);
});

test("`gateMode: off` disables the layer entirely — the documented escape hatch", () => {
  assert.equal(verdictBlocks(verdict("block"), "off"), false);
});

/* ── the acceptance criterion: a BLOCK aborts at A7 ──────────────────────────*/

test("a nemesis BLOCK refuses the command WITHOUT spawning — at any level, A7 included", async () => {
  const { state, spawnImpl } = watchSpawn();
  const home = tmpHome();
  const out = await runSystemTool(
    "run_command",
    { command: "ls -la" },
    {
      cwd: "/repo",
      spawnImpl,
      home,
      authLevel: 7, // RUN ALL — the level whose own description says nemesis still hard-stops
      gateImpl: async () => verdict("block", ["R2.pipe: pipe-to-shell dropper"]),
    },
  );
  assert.equal(out?.ok, false);
  assert.equal(state.spawned, false, "a BLOCKed command must never reach a spawn");
  assert.match(out?.summary ?? "", /refused by the nemesis gate \(block\)/);
  assert.match(out?.summary ?? "", /pipe-to-shell dropper/, "the reason must reach the model");
});

test("the BLOCK rides back as a VERDICT, which aborts the agent loop's round", async () => {
  const { spawnImpl } = watchSpawn();
  const out = await runSystemTool(
    "run_command",
    { command: "ls" },
    { cwd: "/repo", spawnImpl, gateImpl: async () => verdict("block") },
  );
  // core's `runAgentTurn` checks `outcome.verdict` and aborts on block — returning it here is
  // what makes a refusal stop the TURN rather than just this call.
  assert.equal(out?.verdict?.verdict, "block");
});

test("an `error` verdict (scanner missing / timed out) also refuses — fail-closed", async () => {
  const { state, spawnImpl } = watchSpawn();
  const out = await runSystemTool(
    "run_command",
    { command: "ls" },
    {
      cwd: "/repo",
      spawnImpl,
      gateImpl: async () => verdict("error", ["nemesis binary not found"]),
    },
  );
  assert.equal(out?.ok, false);
  assert.equal(state.spawned, false);
});

test("a `warn` verdict does NOT stop the command", async () => {
  const { state, spawnImpl } = watchSpawn();
  const out = await runSystemTool(
    "run_command",
    { command: "ls" },
    { cwd: "/repo", spawnImpl, gateImpl: async () => verdict("warn", ["R3.sudo"]) },
  );
  assert.equal(state.spawned, true, "a warn is a warning, not a refusal");
  assert.equal(out?.ok, true);
});

test("`gateMode: off` skips the scan entirely", async () => {
  let scanned = false;
  const { state, spawnImpl } = watchSpawn();
  await runSystemTool(
    "run_command",
    { command: "ls" },
    {
      cwd: "/repo",
      spawnImpl,
      gateMode: "off",
      gateImpl: async () => {
        scanned = true;
        return verdict("block");
      },
    },
  );
  assert.equal(scanned, false);
  assert.equal(state.spawned, true);
});

/* ── the scan cache: one scan per command, keyed on the exact text ───────────*/

test("the verdict is latched, so confirm→run costs ONE scan", async () => {
  let scans = 0;
  const gate = async () => {
    scans += 1;
    return verdict("allow");
  };
  await scanCommand("ls -la", { gate });
  await scanCommand("ls -la", { gate });
  assert.equal(scans, 1, "the second call must reuse the confirm seam's verdict");
});

test("a DIFFERENT command never inherits another's verdict", async () => {
  const seen: string[] = [];
  const gate = async (text: string) => {
    seen.push(text);
    return verdict("allow");
  };
  await scanCommand("ls -la", { gate });
  await scanCommand("rm -rf build", { gate });
  assert.deepEqual(seen, ["ls -la", "rm -rf build"]);
});

/* ── the audit trail ─────────────────────────────────────────────────────────*/

test("a successful run is recorded with its argv, tier, verdict and exit code", async () => {
  const home = tmpHome();
  const { spawnImpl } = watchSpawn();
  await runSystemTool(
    "run_command",
    { command: "ps aux | wc -l" },
    { cwd: "/repo", spawnImpl, home, authLevel: 4, gateImpl: async () => verdict("allow") },
  );
  const rows = readAudit(home);
  assert.equal(rows.length, 1);
  const row = rows[0] as ExecAuditEntry;
  assert.equal(row.command, "ps aux | wc -l");
  assert.equal(row.tier, "read");
  assert.equal(row.verdict, "allow");
  assert.equal(row.authLevel, 4);
  assert.equal(row.exitCode, 0);
  assert.deepEqual(row.argv, [
    ["ps", "aux"],
    ["wc", "-l"],
  ]);
  assert.ok(Date.parse(row.at) > 0, "every row is timestamped");
});

test("a BLOCKED command is recorded too — a refusal is the most auditable event there is", async () => {
  const home = tmpHome();
  const { spawnImpl } = watchSpawn();
  await runSystemTool(
    "run_command",
    { command: "ls" },
    {
      cwd: "/repo",
      spawnImpl,
      home,
      authLevel: 7,
      gateImpl: async () => verdict("block", ["R2.pipe"]),
    },
  );
  const row = readAudit(home)[0] as ExecAuditEntry;
  assert.equal(row.decision, "blocked");
  assert.equal(row.verdict, "block");
  assert.match(row.reason ?? "", /R2\.pipe/);
});

test("the audit records the RENDERED command, not the model's raw string", async () => {
  const home = tmpHome();
  const { spawnImpl } = watchSpawn();
  await runSystemTool(
    "run_command",
    { command: "grep    'a b'     file" },
    { cwd: "/repo", spawnImpl, home, gateImpl: async () => verdict("allow") },
  );
  const row = readAudit(home)[0] as ExecAuditEntry;
  assert.equal(row.command, "grep 'a b' file", "the audit must show what actually ran");
});

test("appending never throws, even on an unwritable home", () => {
  // An audit that can break the turn it audits gets deleted the first time a full disk stops
  // someone working — and then there is no audit at all.
  assertStrict.doesNotThrow(() =>
    appendExecAudit(
      "/nonexistent/ /path",
      execAuditEntry({
        command: "ls",
        tier: "read",
        verdict: "allow",
        decision: "auto",
        authLevel: 1,
      }),
    ),
  );
});

test("the exec audit is its OWN file, not the engine's gate-audit.jsonl", () => {
  // Writing into another component's append-only store would make both sides' invariants
  // everyone's problem.
  assert.match(execAuditPath("/home"), /exec-audit\.jsonl$/);
  assert.ok(!execAuditPath("/home").includes("gate-audit"));
});
