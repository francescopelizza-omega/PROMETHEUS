/**
 * verify.test.ts — plugin registration verify/repair (CLI-056). Plain npm + node:test (NOT vitest,
 * NOT @prometheus/*). Fixture config dirs under a temp home + injected fs/exec seams — no real
 * agents, no monkeypatching after import.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentTarget, Format } from "./agents.js";
import {
  type VerifyDeps,
  classifyPath,
  entryServerPath,
  readRegistration,
  runRepair,
  runVerify,
  verifyAgent,
} from "./verify.js";

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

test.after(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});
