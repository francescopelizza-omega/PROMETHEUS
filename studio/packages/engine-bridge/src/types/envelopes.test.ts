import assert from "node:assert/strict";
/**
 * envelopes.test.ts — typed-fixture tests, ONE per command envelope (file 02 §3.3).
 *
 * Each test takes a REAL/sample object (the bytes the engine actually emits,
 * captured by probing `python3 prometheus.py --json <cmd>` at 0.15.0) and asserts
 * it satisfies the typed shape — a compile-time `satisfies` (the file would not
 * type-check if the type drifted) PLUS runtime assertions on the discriminant +
 * key payload fields. Also exercises the isCommand() narrowing helper.
 */
import { test } from "node:test";

import { isCommand } from "./index.js";
import type {
  AuditEnvelope,
  Envelope,
  InfoEnvelope,
  InstallEnvelope,
  ListEnvelope,
  MatrixEnvelope,
  ScanEnvelope,
  SkillsEnvelope,
  StatusEnvelope,
  SuperscanEnvelope,
  VaultEnvelope,
  WhereEnvelope,
} from "./index.js";

test("ScanEnvelope: real scan object fits the type + narrows", () => {
  const scan = {
    command: "scan",
    ok: true,
    os: { family: "macos", pkg_manager: "brew" },
    agents: [
      { name: "claude", label: "Claude Code", kind: "cli", present: true, where: "/x/claude" },
      { name: "zed", label: "Zed", kind: "ide", present: false, where: "not found" },
    ],
  } satisfies ScanEnvelope;

  const env: Envelope = scan;
  assert.ok(isCommand(env, "scan"));
  if (isCommand(env, "scan")) {
    assert.equal(env.os.pkg_manager, "brew");
    assert.equal(env.agents[0]?.present, true);
    assert.equal(env.agents[1]?.where, "not found");
  }
});

test("SuperscanEnvelope: deep-inventory row fits the type", () => {
  const ss = {
    command: "superscan",
    ok: true,
    os: { family: "macos", pkg_manager: "brew" },
    agents: [
      {
        name: "claude",
        label: "Claude Code",
        kind: "cli",
        present: true,
        binary: "/x/claude",
        version: "2.1.178 (Claude Code)",
        config_dir: "/Users/x/.claude",
        stale_days: 0,
        forgotten: false,
        counts: { plugins: 1, skills: 0, mcp: 0, extensions: 0, rules: 0, commands: 0 },
        total: 1,
      },
    ],
  } satisfies SuperscanEnvelope;
  assert.equal(ss.agents[0]?.counts.plugins, 1);
  assert.equal(ss.agents[0]?.version, "2.1.178 (Claude Code)");
});

test("ListEnvelope: CatalogEntry with null stars/license + targets map", () => {
  const list = {
    command: "list",
    ok: true,
    catalog: [
      {
        name: "caveman",
        tier: "community",
        summary: "Ultra-compressed comms mode",
        repo: "JuliusBrussee/caveman",
        stars: null,
        license: "MIT",
        scope: "claude-only",
        supported_os: ["macos", "linux"],
        recommend_rank: null,
        targets: { claude: { method: "claude_plugin", installed: true } },
      },
    ],
  } satisfies ListEnvelope;
  assert.equal(list.catalog[0]?.stars, null);
  assert.equal(list.catalog[0]?.targets.claude?.installed, true);
});

test("InstallEnvelope: blocked dry-run fits the type (ok:false, summary tally)", () => {
  const inst = {
    command: "install",
    ok: false,
    request: { plugin: "caveman", dry_run: true, target_agents: ["claude"] },
    results: {
      install_events: [
        {
          plugin: "caveman",
          agent: "claude",
          scope: "claude-only",
          method: "claude_plugin",
          result: "blocked",
        },
      ],
      summary: { blocked: 1 },
    },
    _exit: 1,
  } satisfies InstallEnvelope;

  const env: Envelope = inst;
  assert.ok(isCommand(env, "install"));
  if (isCommand(env, "install")) {
    assert.equal(env.results.install_events[0]?.result, "blocked");
    assert.equal(env.results.summary.blocked, 1);
    assert.equal(env.ok, false);
  }
});

test("InstallEnvelope: forced_danger override is representable (ok:false, different bad)", () => {
  const forced = {
    command: "install",
    ok: false,
    request: { plugin: "caveman", dry_run: false, target_agents: ["claude"] },
    results: {
      install_events: [
        {
          plugin: "caveman",
          agent: "claude",
          scope: "claude-only",
          method: "claude_plugin",
          result: "installed",
        },
      ],
      summary: { installed: 1 },
    },
    forced_danger: [
      {
        label: "JuliusBrussee/caveman",
        verdict: "block",
        risk_score: 100,
        blocking_reasons: ["DROP-001 @ ..."],
      },
    ],
    _exit: 1,
  } satisfies InstallEnvelope;
  assert.equal(forced.forced_danger?.[0]?.verdict, "block");
  assert.equal(forced.ok, false);
});

test("AuditEnvelope: severity vs verdict-tier axes are NOT conflated", () => {
  const audit = {
    command: "audit",
    ok: false,
    request: { plugin: "caveman" },
    worst_verdict: "critical",
    audits: [
      {
        agent: "claude",
        method: "claude_plugin",
        scan_report: {
          verdict: "clean", // SEVERITY axis
          identity: "655b7d9c5431f822",
          scanned_files: 174,
          active_findings: [],
          downgraded_count: 48,
        },
        nemesis_verdicts: [
          {
            source: "JuliusBrussee/caveman",
            verdict: "block", // DECISION axis
            risk_score: 100,
            recommendation: "DO NOT install or run.",
            blocking_reasons: ["DROP-001 @ /tmp/.../README.md"],
          },
        ],
      },
    ],
    _exit: 1,
  } satisfies AuditEnvelope;

  assert.equal(audit.worst_verdict, "critical"); // severity
  assert.equal(audit.audits[0]?.scan_report.verdict, "clean"); // severity
  assert.equal(audit.audits[0]?.nemesis_verdicts[0]?.verdict, "block"); // tier
});

test("InfoEnvelope: plugin metadata + targets map + components", () => {
  const info = {
    command: "info",
    ok: true,
    plugin: {
      name: "caveman",
      summary: "Ultra-compressed comms mode",
      tier: "community",
      scope: "claude-only",
      repo: "JuliusBrussee/caveman",
      license: "MIT",
      stars: null,
      category: "comms-style",
      recommend_rank: null,
      automation: "Output-style + skills plugin",
      security_note: "",
      caveats: [],
      post_install_note: "",
      supported_os: ["macos", "linux"],
      targets: {
        claude: {
          method: "claude_plugin",
          marketplace_name: "caveman",
          marketplace_repo: "JuliusBrussee/caveman",
          mcp_name: null,
          repo_url: null,
          dest: null,
          universal_add: null,
          shell_steps: null,
        },
      },
      components: [{ name: "caveman@caveman", kind: "subplugin", desc: "" }],
    },
  } satisfies InfoEnvelope;
  assert.equal(info.plugin.targets.claude?.marketplace_name, "caveman");
  assert.equal(info.plugin.components[0]?.kind, "subplugin");
});

test("WhereEnvelope: targets is an ARRAY of per-agent rows", () => {
  const where = {
    command: "where",
    ok: true,
    plugin: {
      name: "caveman",
      scope: "claude-only",
      targets: [
        {
          agent: "claude",
          method: "claude_plugin",
          dest: "~/.claude/plugins (+ enabledPlugins)",
          mcp_name: null,
          repo_url: null,
          universal_add: null,
        },
      ],
    },
  } satisfies WhereEnvelope;
  assert.equal(where.plugin.targets[0]?.agent, "claude");
  assert.ok(Array.isArray(where.plugin.targets));
});

test("StatusEnvelope: status all shape (plugins[].agents[]/components[])", () => {
  const status = {
    command: "status",
    ok: true,
    plugins: [
      {
        name: "claude-plugins-official",
        tier: "official",
        agents: [
          {
            name: "claude",
            method: "claude_marketplace",
            installed: true,
            marketplace_present: true,
          },
        ],
        components: [],
      },
      {
        name: "skills",
        tier: "official",
        agents: [
          { name: "claude", method: "claude_plugin", installed: false, marketplace_present: false },
        ],
        components: [
          { name: "document-skills@anthropic-agent-skills", kind: "subplugin", state: "absent" },
        ],
      },
    ],
  } satisfies StatusEnvelope;
  assert.equal(status.plugins[0]?.agents[0]?.installed, true);
  assert.equal(status.plugins[1]?.components[0]?.state, "absent");
});

test("MatrixEnvelope: reach rows with compact scope code", () => {
  const matrix = {
    command: "matrix",
    ok: true,
    agents: ["claude", "codex", "cursor"],
    reach: [
      {
        plugin: "caveman",
        scope: "C",
        native: ["claude"],
        sync: [],
        unavailable: ["codex", "cursor"],
      },
      {
        plugin: "superpowers",
        scope: "U",
        native: ["claude", "gemini"],
        sync: [],
        unavailable: ["codex"],
      },
    ],
  } satisfies MatrixEnvelope;
  assert.equal(matrix.reach[0]?.scope, "C");
  assert.deepEqual(matrix.reach[1]?.native, ["claude", "gemini"]);
});

test("SkillsEnvelope: empty skills dir fits the type", () => {
  const skills = {
    command: "skills",
    ok: true,
    action: "list",
    skills_dir: "/Users/x/.claude/skills",
    skills: [],
  } satisfies SkillsEnvelope;
  assert.equal(skills.action, "list");
  assert.deepEqual(skills.skills, []);
});

test("VaultEnvelope: uninitialised vault with absent repos", () => {
  const vault = {
    command: "vault",
    ok: true,
    action: "status",
    root: null,
    initialized: false,
    repos: [
      { id: "caveman", name: "caveman", source: "plugin", stored_versions: [], state: "absent" },
    ],
  } satisfies VaultEnvelope;
  assert.equal(vault.initialized, false);
  assert.equal(vault.repos[0]?.state, "absent");
});

test("isCommand: rejects a mismatched discriminant", () => {
  const env: Envelope = {
    command: "list",
    ok: true,
    catalog: [],
  } satisfies ListEnvelope;
  assert.equal(isCommand(env, "scan"), false);
  assert.equal(isCommand(env, "list"), true);
});
