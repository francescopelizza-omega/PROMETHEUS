/**
 * verify.test.ts — plugin registration verify/repair (CLI-056). Plain npm + node:test (NOT vitest,
 * NOT @prometheus/*). Fixture config dirs under a temp home + injected fs/exec seams — no real
 * agents, no monkeypatching after import.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import TOML from "@iarna/toml";

import { type AgentTarget, type Format, type Launch, stableNodePath } from "./agents.js";
import {
  type Finding,
  type VerifyDeps,
  classifyPath,
  entryServerPath,
  readRegistration,
  runRepair,
  runVerify,
  verifyAgent,
} from "./verify.js";
import { applyAgent } from "./writers.js";

let TMP = "";
function tmp(): string {
  if (!TMP) TMP = mkdtempSync(join(tmpdir(), "prom-verify-"));
  return TMP;
}
function writeFixture(name: string, content: string): string {
  const p = join(tmp(), name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

/** A synthetic agent target (no real home) for a given format + config path. */
function agent(id: string, format: Format, configPath: string, extra: Partial<AgentTarget> = {}): AgentTarget {
  return {
    id,
    label: id,
    binaries: [],
    markers: [configPath],
    configPath,
    format,
    note: "",
    ...extra,
  };
}

function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    existsSync,
    readFileSync: (p) => readFileSync(p, "utf8"),
    realpath: realpathSync,
    exec: () => null,
    commandExists: () => false,
    resolvedServerJs: "/resolved/server.js",
    resolvedPy: "/resolved/prometheus.py",
    ...over,
  };
}

/* ── read-back per format: all four named adapters (acceptance #5) ── */

test("cursor (json-mcpServers) read-back finds the prometheus entry (CLI-056)", () => {
  const text = JSON.stringify({ mcpServers: { prometheus: { command: "node", args: ["/x/server.js"] } } });
  const { reg, entry } = readRegistration("json-mcpServers", text, "cfg");
  assert.equal(reg, "present");
  assert.deepEqual(entry?.args, ["/x/server.js"]);
  assert.equal(readRegistration("json-mcpServers", "{}", "cfg").reg, "absent");
  assert.equal(readRegistration("json-mcpServers", "{not json", "cfg").reg, "malformed");
});

test("codex (toml-mcpServers) read-back parses [mcp_servers.prometheus] (CLI-056)", () => {
  const text = '[mcp_servers.prometheus]\ncommand = "node"\nargs = ["/x/server.js"]\n[mcp_servers.prometheus.env]\nPROMETHEUS_PY = "/x/p.py"\n';
  const { reg, entry } = readRegistration("toml-mcpServers", text, "cfg");
  assert.equal(reg, "present");
  assert.equal(entry?.command, "node");
  assert.equal(entry?.env?.PROMETHEUS_PY, "/x/p.py");
  assert.equal(readRegistration("toml-mcpServers", "[other]\nx=1", "cfg").reg, "absent");
});

test("gemini (gemini-extension) read-back locates the manifest entry (CLI-056)", () => {
  const text = JSON.stringify({ name: "prometheus", mcpServers: { prometheus: { command: "node", args: ["/x/server.js"] } } });
  assert.equal(readRegistration("gemini-extension", text, "manifest").reg, "present");
  assert.equal(readRegistration("gemini-extension", JSON.stringify({ name: "x" }), "manifest").reg, "absent");
});

test("continue (yaml-list) read-back finds the named list entry (CLI-056)", () => {
  const text = "mcpServers:\n  - name: prometheus\n    command: node\n    args: [/x/server.js]\n";
  assert.equal(readRegistration("yaml-list", text, "cfg").reg, "present");
  assert.equal(readRegistration("yaml-list", "mcpServers:\n  - name: other\n", "cfg").reg, "absent");
});

test("claude is verified via its CLI store, not ~/.claude.json (CLI-056)", () => {
  const claude = agent("claude", "json-mcpServers", "/nope/.claude.json", {
    cliRegister: () => ({ bin: "claude", argv: ["mcp", "add"] }),
  });
  // binary present + `claude mcp get prometheus` mentions it → present.
  const present = verifyAgent(claude, deps({ commandExists: (b) => b === "claude", exec: () => "prometheus: node ..." }));
  assert.equal(present.reg, "present");
  // binary absent → cannot-verify (never a false absent).
  const noBin = verifyAgent(claude, deps({ commandExists: () => false }));
  assert.equal(noBin.reg, "cannot-verify");
});

/* ── path classification ── */

test("entryServerPath: local .js arg, env override, npx → undefined (CLI-056)", () => {
  assert.equal(entryServerPath({ command: "node", args: ["/a/server.js"] }), "/a/server.js");
  assert.equal(entryServerPath({ command: "node", args: ["/a/server.js"], env: { PROMETHEUS_MCP_SERVER: "/b/s.js" } }), "/b/s.js");
  assert.equal(entryServerPath({ command: "npx", args: ["-y", "@x/mcp"] }), undefined);
});

test("classifyPath: missing / drifted / ok (CLI-056)", () => {
  const server = writeFixture("build/server.js", "// built\n");
  // OK: registered path IS the resolved path.
  assert.equal(classifyPath({ command: "node", args: [server] }, deps({ resolvedServerJs: server })).path, "ok");
  // MISSING: registered path is gone (repo moved).
  assert.equal(classifyPath({ command: "node", args: ["/gone/server.js"] }, deps({ resolvedServerJs: server })).path, "missing");
  // DRIFTED: registered path exists but differs from the current build.
  const other = writeFixture("old/server.js", "// old\n");
  assert.equal(classifyPath({ command: "node", args: [other] }, deps({ resolvedServerJs: server })).path, "drifted");
});

/* ── verify driver + exit codes ── */

test("healthy fixture → all green, exit 0 (CLI-056)", async () => {
  const server = writeFixture("h/server.js", "// built\n");
  const cfg = writeFixture("h/mcp.json", JSON.stringify({ mcpServers: { prometheus: { command: "node", args: [server] } } }));
  const a = agent("cursor", "json-mcpServers", cfg);
  const res = await runVerify([a], deps({ resolvedServerJs: server }), { smoke: true, boot: async () => true });
  assert.equal(res.exitCode, 0);
  assert.equal(res.findings[0]?.reg, "present");
  assert.equal(res.findings[0]?.path, "ok");
  assert.equal(res.findings[0]?.boot, "ok");
});

test("missing server.js → MISSING, exit 1 (CLI-056)", async () => {
  const cfg = writeFixture("m/mcp.json", JSON.stringify({ mcpServers: { prometheus: { command: "node", args: ["/gone/server.js"] } } }));
  const a = agent("cursor", "json-mcpServers", cfg);
  const res = await runVerify([a], deps(), { smoke: true, boot: async () => true });
  assert.equal(res.exitCode, 1);
  assert.equal(res.findings[0]?.path, "missing");
  assert.equal(res.findings[0]?.fixable, true);
});

test("verify performs ZERO writes (fixture byte-identical) (CLI-056)", async () => {
  const cfg = writeFixture("ro/mcp.json", JSON.stringify({ mcpServers: { prometheus: { command: "node", args: ["/gone/server.js"] } } }));
  const before = readFileSync(cfg, "utf8");
  await runVerify([agent("cursor", "json-mcpServers", cfg)], deps(), { smoke: false });
  assert.equal(readFileSync(cfg, "utf8"), before);
});

/* ── repair ── */

test("repair rewrites a MISSING path to the resolved server.js after confirm (CLI-056)", async () => {
  const server = writeFixture("r/server.js", "// built\n");
  const py = writeFixture("r/prometheus.py", "# engine\n");
  const cfg = writeFixture("r/mcp.json", JSON.stringify({ mcpServers: { prometheus: { command: "node", args: ["/gone/server.js"] } } }));
  const a = agent("cursor", "json-mcpServers", cfg);
  const d = deps({ resolvedServerJs: server, resolvedPy: py });
  const findings = (await runVerify([a], d, { smoke: false })).findings;

  // declined → nothing written (byte-identical).
  const before = readFileSync(cfg, "utf8");
  const declined = await runRepair([a], findings, d, async () => false);
  assert.equal(declined.skipped, true);
  assert.deepEqual(declined.rewritten, []);
  assert.equal(readFileSync(cfg, "utf8"), before);

  // confirmed → rewritten to the resolved server path.
  const ok = await runRepair([a], findings, d, async () => true);
  assert.deepEqual(ok.rewritten, ["cursor"]);
  const after = JSON.parse(readFileSync(cfg, "utf8"));
  assert.equal(after.mcpServers.prometheus.args.at(-1), server);
  assert.equal(after.mcpServers.prometheus.env.PROMETHEUS_PY, py);

  // and now verify is green.
  const res2 = await runVerify([a], d, { smoke: false });
  assert.equal(res2.exitCode, 0);
});

test("repair does nothing when there are no fixable findings (CLI-056)", async () => {
  const server = writeFixture("n/server.js", "// built\n");
  const cfg = writeFixture("n/mcp.json", JSON.stringify({ mcpServers: { prometheus: { command: "node", args: [server] } } }));
  const a = agent("cursor", "json-mcpServers", cfg);
  const d = deps({ resolvedServerJs: server });
  const findings = (await runVerify([a], d, { smoke: false })).findings;
  const r = await runRepair([a], findings, d, async () => true);
  assert.deepEqual(r.rewritten, []);
  assert.equal(r.skipped, false);
});

/* ── the interpreter a registration names (2026-10-03: a dead Homebrew Cellar node) ── */

test("stableNodePath names the running node by its upgrade-stable link, never a different binary", () => {
  // realpath: macOS tmpdir is under /var -> /private/var, and the opt link is derived from the real path
  const root = join(realpathSync(tmp()), "brew");
  const real = join(root, "Cellar", "node", "9.9.9", "bin", "node");
  mkdirSync(join(real, ".."), { recursive: true });
  writeFileSync(real, "#!/bin/sh\n");
  mkdirSync(join(root, "opt"), { recursive: true });
  symlinkSync(join("..", "Cellar", "node", "9.9.9"), join(root, "opt", "node"));
  mkdirSync(join(root, "bin"), { recursive: true });
  symlinkSync(join("..", "Cellar", "node", "9.9.9", "bin", "node"), join(root, "bin", "node"));
  const home = join(tmp(), "home");
  const prom = join(tmp(), "prom");
  // A PATH entry that resolves to the same binary wins: it is what the user's shell runs.
  assert.equal(stableNodePath(real, join(root, "bin"), home, prom), join(root, "bin", "node"));
  // No PATH help: Homebrew's opt link for the same formula.
  assert.equal(stableNodePath(real, "", home, prom), join(root, "opt", "node", "bin", "node"));
  // fnm's per-shell links die with the shell, so they are never persisted.
  const multi = join(tmp(), "fnm_multishells", "123_456", "bin");
  mkdirSync(multi, { recursive: true });
  symlinkSync(real, join(multi, "node"));
  assert.equal(stableNodePath(real, multi, home, prom), join(root, "opt", "node", "bin", "node"));
  // A link to a DIFFERENT binary is never chosen: the spelling changes, the interpreter does not.
  const other = join(tmp(), "other-node");
  writeFileSync(other, "#!/bin/sh\n");
  const decoy = join(tmp(), "decoy-bin");
  mkdirSync(decoy, { recursive: true });
  symlinkSync(other, join(decoy, "node"));
  const lone = join(tmp(), "lone", "bin", "node");
  mkdirSync(join(lone, ".."), { recursive: true });
  writeFileSync(lone, "#!/bin/sh\n");
  assert.equal(stableNodePath(lone, decoy, home, prom), lone);
  // The installer's private toolchain: its versioned directory changes with the pin, the link does not.
  const tc = join(prom, "toolchain");
  const versioned = join(tc, "node-v22.0.0-test", "bin", "node");
  mkdirSync(join(versioned, ".."), { recursive: true });
  writeFileSync(versioned, "#!/bin/sh\n");
  symlinkSync("node-v22.0.0-test", join(tc, "node"));
  assert.equal(stableNodePath(versioned, "", home, prom), join(tc, "node", "bin", "node"));
});

test("classifyPath: an absolute interpreter that is gone is MISSING even when server.js exists", () => {
  const server = writeFixture("interp/server.js", "// built\n");
  const c = classifyPath(
    { command: "/opt/homebrew/Cellar/node/0.0.0-gone/bin/node", args: [server] },
    deps({ resolvedServerJs: server }),
  );
  assert.equal(c.path, "missing");
  assert.match(c.reason ?? "", /interpreter is gone/);
  // A bare command resolves on the client's PATH: not ours to judge.
  assert.equal(classifyPath({ command: "node", args: [server] }, deps({ resolvedServerJs: server })).path, "ok");
});

test("claude: a registered entry with a dead interpreter is MISSING and fixable", () => {
  const server = writeFixture("cl/server.js", "// built\n");
  const cfg = writeFixture(
    "cl/.claude.json",
    JSON.stringify({ mcpServers: { prometheus: { type: "stdio", command: "/gone/node", args: [server] } } }),
  );
  const claude = agent("claude", "json-mcpServers", cfg, {
    cliRegister: () => ({ bin: "claude", argv: ["mcp", "add"] }),
  });
  const f = verifyAgent(
    claude,
    deps({ commandExists: (b) => b === "claude", exec: () => "prometheus:\n  Command: /gone/node", resolvedServerJs: server }),
  );
  assert.equal(f.reg, "present");
  assert.equal(f.path, "missing");
  assert.equal(f.fixable, true);
});

test("repair re-registers claude by REMOVING the stale entry first (claude mcp add refuses an existing name)", async () => {
  const calls: string[] = [];
  const claude = agent("claude", "json-mcpServers", "/nope/.claude.json", {
    cliRegister: () => ({ bin: "claude", argv: ["mcp", "add", "prometheus"] }),
    cliUnregister: () => ({ bin: "claude", argv: ["mcp", "remove", "prometheus", "--scope", "user"] }),
  });
  const d = deps({
    commandExists: (b) => b === "claude",
    exec: (_b, a) => {
      calls.push(a.slice(0, 2).join(" "));
      return "ok";
    },
  });
  const f: Finding = { agent: "claude", detected: true, reg: "present", path: "missing", boot: "skipped", detail: "", fixable: true };
  const r = await runRepair([claude], [f], d, async () => true);
  assert.deepEqual(r.rewritten, ["claude"]);
  assert.deepEqual(calls, ["mcp remove", "mcp add"]);
});

test("a registration that fails to boot is fixable (it used to be 'nothing to repair')", async () => {
  const server = writeFixture("boot/server.js", "// built\n");
  const cfg = writeFixture("boot/mcp.json", JSON.stringify({ mcpServers: { prometheus: { command: "node", args: [server] } } }));
  const res = await runVerify([agent("cursor", "json-mcpServers", cfg)], deps({ resolvedServerJs: server }), {
    smoke: true,
    boot: async () => false,
  });
  assert.equal(res.findings[0]?.boot, "fail");
  assert.equal(res.findings[0]?.fixable, true);
});

test("repair never persists a PROMETHEUS_PY that does not exist", async () => {
  const server = writeFixture("nopy/server.js", "// built\n");
  const cfg = writeFixture("nopy/mcp.json", JSON.stringify({ mcpServers: { prometheus: { command: "node", args: ["/gone/server.js"] } } }));
  const a = agent("cursor", "json-mcpServers", cfg);
  const d = deps({ resolvedServerJs: server, resolvedPy: "/nowhere/prometheus.py" });
  const findings = (await runVerify([a], d, { smoke: false })).findings;
  await runRepair([a], findings, d, async () => true);
  const after = JSON.parse(readFileSync(cfg, "utf8"));
  assert.equal(after.mcpServers.prometheus.env.PROMETHEUS_PY, undefined);
});

/* ── the Codex TOML writer (2026-10-03: a top-level [env], duplicated by every re-run) ── */

const LAUNCH: Launch = { command: "/opt/homebrew/bin/node", args: ["/x/server.js"] };

test("codex writer keeps env INSIDE the server table, and a re-run stays valid TOML", () => {
  const cfg = writeFixture("codex1/config.toml", '# my settings\nmodel = "o3"\n\n[other]\nx = 1\n');
  const codex = agent("codex", "toml-mcpServers", cfg);
  applyAgent(codex, "/x/prometheus.py", false, LAUNCH);
  applyAgent(codex, "/x/prometheus.py", false, LAUNCH); // the repair/re-run that used to corrupt the file
  const text = readFileSync(cfg, "utf8");
  const parsed = TOML.parse(text) as Record<string, any>;
  assert.equal(parsed.env, undefined, `no top-level [env]:\n${text}`);
  assert.equal(parsed.mcp_servers.prometheus.env.PROMETHEUS_PY, "/x/prometheus.py");
  assert.equal(parsed.mcp_servers.prometheus.command, "/opt/homebrew/bin/node");
  assert.equal(parsed.other.x, 1);
  assert.equal(text.match(/\[mcp_servers\.prometheus\]/g)?.length, 1);
  assert.match(text, /# my settings/);
});

test("codex writer repairs the file the old writer left behind (orphan [env], sub-table)", () => {
  const broken =
    '[mcp_servers.prometheus]\ncommand = "/opt/homebrew/Cellar/node/26.5.0/bin/node"\nargs = [ "/x/server.js" ]\n' +
    'startup_timeout_sec = 30\ntool_timeout_sec = 600\n\n[env]\nPROMETHEUS_PY = "/tmp/missing.py"\n';
  const cfg = writeFixture("codex2/config.toml", broken);
  applyAgent(agent("codex", "toml-mcpServers", cfg), "/x/prometheus.py", false, LAUNCH);
  const parsed = TOML.parse(readFileSync(cfg, "utf8")) as Record<string, any>;
  assert.equal(parsed.env, undefined);
  assert.equal(parsed.mcp_servers.prometheus.env.PROMETHEUS_PY, "/x/prometheus.py");

  // `codex mcp add` writes env as [mcp_servers.prometheus.env]: replaced with its parent, not duplicated.
  const sub = '[mcp_servers.prometheus]\ncommand = "node"\n\n[mcp_servers.prometheus.env]\nPROMETHEUS_PY = "/old.py"\n\n[keep]\ny = 2\n';
  const cfg2 = writeFixture("codex3/config.toml", sub);
  applyAgent(agent("codex", "toml-mcpServers", cfg2), "", false, LAUNCH);
  const p2 = TOML.parse(readFileSync(cfg2, "utf8")) as Record<string, any>;
  assert.equal(p2.mcp_servers.prometheus.env, undefined, "no PROMETHEUS_PY when none is known");
  assert.equal(p2.keep.y, 2);
});

test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});
