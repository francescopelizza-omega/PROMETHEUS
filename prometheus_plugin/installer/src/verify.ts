// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * verify.ts — `prometheus-install verify` / `repair` (CLI-056).
 *
 * Checks each detected agent's MCP registration by READING BACK its config (the inverse of the
 * writers.ts format writers), classifies the registered server path as OK / MISSING / DRIFTED
 * (the repo-move trap: ALPHA/AI → ALPHA/PROMETHEUS, 2026-06-12), optionally boot-smokes the
 * registered server, and — under `repair`, behind an explicit confirm — rewrites fixable
 * registrations via the EXISTING writers. `verify` NEVER writes.
 *
 * Everything is dependency-injected (fs / exec / realpath / resolved paths) so the whole surface
 * is unit-testable against fixture config dirs with a fake home — no monkeypatching after import.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import TOML from "@iarna/toml";
import { parse as parseYaml } from "yaml";

import { type AgentTarget, type Format, buildLaunch, commandExists, resolveServerJs } from "./agents.js";
import { applyAgent } from "./writers.js";

/** Registration presence for one agent. */
export type RegState = "present" | "absent" | "malformed" | "cannot-verify";
/** Registered server-path health. */
export type PathState = "ok" | "missing" | "drifted" | "unknown";
/** Boot-smoke outcome. */
export type BootState = "ok" | "fail" | "skipped";

/** The prometheus server entry read back out of an agent config. */
export interface RegEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Finding {
  agent: string;
  detected: boolean;
  reg: RegState;
  path: PathState;
  boot: BootState;
  /** server.js path found in the registration (from args or PROMETHEUS_MCP_SERVER). */
  serverPath?: string;
  /** prometheus.py path found (env.PROMETHEUS_PY). */
  pyPath?: string;
  detail: string;
  /** repairable: a detected agent with an absent/malformed entry, or a missing/drifted path. */
  fixable: boolean;
}

/** Injected seams so verify is pure + testable (no real fs/exec/home in unit tests). */
export interface VerifyDeps {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  /** resolves symlinks; MUST throw when the path is missing (drift compare uses it). */
  realpath: (p: string) => string;
  /** run a command capturing stdout; null on any failure (missing binary / non-zero exit). */
  exec: (bin: string, argv: string[]) => string | null;
  commandExists: (bin: string) => boolean;
  /** the currently-resolved server.js — the DRIFT target. */
  resolvedServerJs: string;
  /** the currently-resolved prometheus.py — the DRIFT target. */
  resolvedPy: string;
}

/* --------------------------- config read-back --------------------------- */

function pick(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Coerce a parsed server node into a RegEntry (command/args/env), or undefined if not object. */
function toEntry(node: unknown): RegEntry | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as Record<string, unknown>;
  const entry: RegEntry = {};
  if (typeof n.command === "string") entry.command = n.command;
  if (Array.isArray(n.args)) entry.args = n.args.map(String);
  if (n.env && typeof n.env === "object") entry.env = n.env as Record<string, string>;
  return entry;
}

/**
 * Read the `prometheus` registration out of one agent config, using the inverse of its format
 * writer. Returns `absent` when the file exists but has no prometheus entry, `malformed` when the
 * file can't be parsed in its declared format.
 */
export function readRegistration(
  format: Format,
  configText: string,
  _configPath: string,
): { reg: RegState; entry?: RegEntry } {
  if (!configText.trim()) return { reg: "absent" };
  try {
    switch (format) {
      case "json-mcpServers":
      case "json-cline": {
        const node = pick(pick(JSON.parse(configText), "mcpServers"), "prometheus");
        return node ? { reg: "present", entry: toEntry(node) } : { reg: "absent" };
      }
      case "json-contextServers": {
        const node = pick(pick(JSON.parse(configText), "context_servers"), "prometheus");
        return node ? { reg: "present", entry: toEntry(node) } : { reg: "absent" };
      }
      case "toml-mcpServers": {
        const node = pick(pick(TOML.parse(configText), "mcp_servers"), "prometheus");
        return node ? { reg: "present", entry: toEntry(node) } : { reg: "absent" };
      }
      case "yaml-list": {
        const list = pick(parseYaml(configText), "mcpServers");
        if (!Array.isArray(list)) return { reg: "absent" };
        const node = list.find((it) => pick(it, "name") === "prometheus");
        return node ? { reg: "present", entry: toEntry(node) } : { reg: "absent" };
      }
      case "gemini-extension": {
        // configPath IS the extension manifest; the entry lives under mcpServers.prometheus.
        const node = pick(pick(JSON.parse(configText), "mcpServers"), "prometheus");
        return node ? { reg: "present", entry: toEntry(node) } : { reg: "absent" };
      }
      default:
        return { reg: "cannot-verify" };
    }
  } catch {
    return { reg: "malformed" };
  }
}

/* --------------------------- path classification --------------------------- */

/** The local server.js path a registration launches, or undefined for an npx launch. */
export function entryServerPath(entry: RegEntry | undefined): string | undefined {
  if (!entry) return undefined;
  // env override wins (matches agents.ts resolveServerJs precedence).
  const envPath = entry.env?.PROMETHEUS_MCP_SERVER;
  if (envPath) return envPath;
  if (entry.command === "npx") return undefined; // published launch — nothing local to check
  // local mode: `node <abs>/dist/server.js` → the last .js arg is the server entry.
  const js = (entry.args ?? []).filter((a) => a.endsWith(".js")).at(-1);
  return js;
}

/** Same-path via realpath (catches the ALPHA/AI→ALPHA/PROMETHEUS symlink/move drift). */
function samePath(a: string, b: string, deps: VerifyDeps): boolean {
  if (a === b) return true;
  try {
    return deps.realpath(a) === deps.realpath(b);
  } catch {
    return false;
  }
}

/**
 * Classify the registered path: MISSING (file gone), DRIFTED (differs from the current resolved
 * server.js / prometheus.py), OK, or UNKNOWN (npx launch — no local path to check).
 */
export function classifyPath(
  entry: RegEntry | undefined,
  deps: VerifyDeps,
): { path: PathState; serverPath?: string; pyPath?: string; reason?: string } {
  const serverPath = entryServerPath(entry);
  const pyPath = entry?.env?.PROMETHEUS_PY;
  const sp = serverPath ? { serverPath } : {};
  const pp = pyPath ? { pyPath } : {};
  // The interpreter is part of the registration. A versioned node (Homebrew Cellar, nvm, fnm,
  // volta, asdf, mise) dies with the version that owned it while server.js beside it survives, so
  // a registration that ENOENTs on every launch used to classify "ok" (2026-10-03:
  // /opt/homebrew/Cellar/node/26.5.0/bin/node after brew moved node to 26.10.0_1). Only an
  // ABSOLUTE command is checkable: a bare `node` / `npx` resolves on the CLIENT's PATH, not ours.
  const command = entry?.command;
  if (command && isAbsolute(command) && !deps.existsSync(command)) {
    return { path: "missing", ...sp, ...pp, reason: `registered interpreter is gone: ${command}` };
  }
  if (!serverPath) return { path: "unknown", ...pp }; // npx / no local entry

  if (!deps.existsSync(serverPath)) {
    return { path: "missing", ...sp, ...pp, reason: `registered server path is gone: ${serverPath}` };
  }
  if (!samePath(serverPath, deps.resolvedServerJs, deps)) return { path: "drifted", ...sp, ...pp };
  // secondary: a stale prometheus.py env also counts as drift/missing.
  if (pyPath) {
    if (!deps.existsSync(pyPath)) {
      return { path: "missing", ...sp, ...pp, reason: `PROMETHEUS_PY is gone: ${pyPath}` };
    }
    if (!samePath(pyPath, deps.resolvedPy, deps)) return { path: "drifted", ...sp, ...pp };
  }
  return { path: "ok", ...sp, ...pp };
}

/* --------------------------- per-agent verify --------------------------- */

/**
 * Verify ONE agent (reg + path only; the boot smoke is a separate async step in runVerify).
 * Claude's ground truth is its OWN store (`claude mcp get prometheus`), NOT ~/.claude.json — a
 * missing binary there yields `cannot-verify`, never a false `absent`.
 */
export function verifyAgent(agent: AgentTarget, deps: VerifyDeps): Finding {
  const detected =
    agent.binaries.some((b) => deps.commandExists(b)) || agent.markers.some((m) => deps.existsSync(m));

  // claude: verify via its CLI, not by parsing the per-project ~/.claude.json.
  if (agent.id === "claude" && agent.cliRegister) {
    if (!deps.commandExists("claude")) {
      return {
        agent: agent.id,
        detected,
        reg: "cannot-verify",
        path: "unknown",
        boot: "skipped",
        detail: "claude binary absent — cannot query its MCP store",
        fixable: false,
      };
    }
    const out = deps.exec("claude", ["mcp", "get", "prometheus"]);
    const present = out !== null && /prometheus/i.test(out);
    if (!present) {
      return {
        agent: agent.id,
        detected,
        reg: "absent",
        path: "unknown",
        boot: "skipped",
        detail: "not in the claude mcp store",
        fixable: detected,
      };
    }
    // `--scope user` lands in ~/.claude.json's top-level mcpServers — the same entry runVerify's
    // boot smoke reads. Presence alone said "registered" for an entry whose interpreter brew had
    // deleted (ENOENT on every launch), so it is classified like every other agent's.
    const text = deps.existsSync(agent.configPath) ? deps.readFileSync(agent.configPath) : "";
    const { entry } = readRegistration("json-mcpServers", text, agent.configPath);
    if (!entry) {
      return {
        agent: agent.id,
        detected,
        reg: "present",
        path: "unknown", // registered in another scope: nothing local to inspect
        boot: "skipped",
        detail: "registered (claude mcp store)",
        fixable: false,
      };
    }
    const c = classifyPath(entry, deps);
    return {
      agent: agent.id,
      detected,
      reg: "present",
      path: c.path,
      boot: "skipped",
      ...(c.serverPath ? { serverPath: c.serverPath } : {}),
      ...(c.pyPath ? { pyPath: c.pyPath } : {}),
      detail:
        c.path === "missing"
          ? (c.reason ?? "registered path is gone")
          : c.path === "drifted"
            ? "registered path drifted from the current build"
            : "registered (claude mcp store)",
      fixable: c.path === "missing" || c.path === "drifted",
    };
  }

  if (!deps.existsSync(agent.configPath)) {
    return {
      agent: agent.id,
      detected,
      reg: "absent",
      path: "unknown",
      boot: "skipped",
      detail: detected ? "detected but no config file yet" : "not installed",
      fixable: detected, // a detected agent with no entry is repairable
    };
  }

  const text = deps.readFileSync(agent.configPath);
  const { reg, entry } = readRegistration(agent.format, text, agent.configPath);
  if (reg === "malformed") {
    return {
      agent: agent.id,
      detected,
      reg,
      path: "unknown",
      boot: "skipped",
      detail: `config is not valid ${agent.format}`,
      fixable: false, // don't auto-rewrite a file we couldn't parse (would clobber user edits)
    };
  }
  if (reg === "absent") {
    return {
      agent: agent.id,
      detected,
      reg,
      path: "unknown",
      boot: "skipped",
      detail: "no prometheus entry",
      fixable: detected,
    };
  }

  const { path, serverPath, pyPath, reason } = classifyPath(entry, deps);
  const fixable = path === "missing" || path === "drifted";
  return {
    agent: agent.id,
    detected,
    reg,
    path,
    boot: "skipped",
    ...(serverPath ? { serverPath } : {}),
    ...(pyPath ? { pyPath } : {}),
    detail:
      path === "missing"
        ? (reason ?? `registered server path is gone: ${serverPath}`)
        : path === "drifted"
          ? `registered path drifted from the current build`
          : path === "unknown"
            ? "registered (npx launch — no local path)"
            : "registered, path current",
    fixable,
  };
}

/* --------------------------- MCP boot smoke --------------------------- */

/** Injectable boot-smoke seam (default = a real stdio initialize roundtrip). */
export type BootSmoke = (entry: RegEntry) => Promise<boolean>;

/**
 * Spawn the registered server and send a single `initialize` JSON-RPC request over stdio,
 * passing ONLY on a response with `id:1` + a `result` carrying serverInfo/capabilities. 5s
 * hard timeout, SIGKILL on expiry, never a shell — argv is an array.
 */
export const defaultBootSmoke: BootSmoke = (entry) =>
  new Promise((resolve) => {
    const command = entry.command;
    const args = entry.args ?? [];
    if (!command) return resolve(false);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 5000,
        killSignal: "SIGKILL",
        env: { ...process.env, ...(entry.env ?? {}) },
      });
    } catch {
      return resolve(false);
    }
    let buf = "";
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    child.on("error", () => finish(false));
    child.on("exit", () => finish(false));
    child.stdout?.on("data", (b: Buffer) => {
      buf += b.toString();
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result && (msg.result.serverInfo || msg.result.capabilities)) {
            return finish(true);
          }
        } catch {
          /* partial line — wait for more */
        }
      }
    });
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "verify", version: "0" },
      },
    };
    try {
      child.stdin?.write(`${JSON.stringify(init)}\n`);
    } catch {
      finish(false);
    }
  });

/* --------------------------- verify + repair drivers --------------------------- */

export interface VerifyResult {
  findings: Finding[];
  exitCode: number;
  text: string;
  json: { ok: boolean; findings: Finding[] };
}

const MARK: Record<string, string> = { ok: "✓", present: "✓", missing: "✗", drifted: "⚠", absent: "○", malformed: "✗", "cannot-verify": "?", fail: "✗", skipped: "·", unknown: "·" };

/** Render the cross-agent summary table (one row per agent). */
export function renderFindings(findings: readonly Finding[]): string {
  const rows = findings.map((f) => {
    const det = f.detected ? "●" : "○";
    return `  ${det} ${f.agent.padEnd(10)} reg:${MARK[f.reg] ?? "?"} path:${MARK[f.path] ?? "?"} boot:${MARK[f.boot] ?? "?"}  ${f.detail}`;
  });
  return ["prometheus MCP registration health (● detected · ○ absent):", ...rows].join("\n");
}

/**
 * Run verify across the given agents. Optionally boot-smokes each PRESENT registration. Exit 1 on
 * any finding (absent-on-detected / malformed / missing / drifted / boot fail), else 0.
 */
export async function runVerify(
  agents: readonly AgentTarget[],
  deps: VerifyDeps,
  opts: { boot?: BootSmoke; smoke?: boolean } = {},
): Promise<VerifyResult> {
  const findings: Finding[] = [];
  for (const agent of agents) {
    const f = verifyAgent(agent, deps);
    // boot smoke only a present, path-ok registration (a missing path can't boot anyway).
    if (opts.smoke && opts.boot && f.reg === "present" && f.path !== "missing") {
      const text = deps.existsSync(agent.configPath) ? deps.readFileSync(agent.configPath) : "";
      const { entry } = readRegistration(agent.format, text, agent.configPath);
      if (entry) f.boot = (await opts.boot(entry)) ? "ok" : "fail";
      // A registration that does not start is worth rewriting to the current build: it used to be
      // reported (exit 1) and then declared "nothing to repair".
      if (f.boot === "fail") f.fixable = true;
    }
    findings.push(f);
  }
  const bad = findings.some(
    (f) =>
      (f.detected && (f.reg === "absent" || f.reg === "malformed")) ||
      f.path === "missing" ||
      f.path === "drifted" ||
      f.boot === "fail",
  );
  return {
    findings,
    exitCode: bad ? 1 : 0,
    text: renderFindings(findings),
    json: { ok: !bad, findings },
  };
}

/** A repair plan line: what the entry points at now → what repair would write. */
export function repairPlan(finding: Finding, deps: VerifyDeps): string {
  const from = finding.serverPath ?? "(absent)";
  return `  ${finding.agent}: ${from} → ${deps.resolvedServerJs}`;
}

/**
 * Repair the fixable findings by rewriting via the EXISTING writers (applyAgent) to the currently
 * resolved server.js + prometheus.py. Confirms ONCE (auto-no when not a TTY unless `yes`). Returns
 * the agents rewritten. `verify` never calls this.
 */
export async function runRepair(
  agents: readonly AgentTarget[],
  findings: readonly Finding[],
  deps: VerifyDeps,
  confirm: (plan: string) => Promise<boolean>,
): Promise<{ rewritten: string[]; skipped: boolean }> {
  const fixable = findings.filter((f) => f.fixable);
  if (fixable.length === 0) return { rewritten: [], skipped: false };
  const plan = ["repair plan (before → after):", ...fixable.map((f) => repairPlan(f, deps))].join("\n");
  if (!(await confirm(plan))) return { rewritten: [], skipped: true };

  const launch = buildLaunch("local", deps.resolvedServerJs);
  // deps.resolvedPy can be the DOCUMENTED default (~/.prometheus/engine/prometheus.py) rather than a
  // file that exists; registering a missing PROMETHEUS_PY makes every tool call fail, so it is left
  // out and the server finds the engine itself.
  const py = deps.resolvedPy && deps.existsSync(deps.resolvedPy) ? deps.resolvedPy : "";
  const rewritten: string[] = [];
  for (const f of fixable) {
    const agent = agents.find((a) => a.id === f.agent);
    if (!agent) continue;
    // claude: re-register via its own CLI (its store is authoritative); others: the file writer.
    if (agent.id === "claude" && agent.cliRegister && deps.commandExists("claude")) {
      const reg = agent.cliRegister(py, launch);
      if (reg) {
        // `claude mcp add` refuses an existing name: without the removal a stale entry was never
        // replaced and repair reported success. Unconditional, because `claude mcp get` may fail
        // for a registered server that cannot connect, so "absent" does not prove absence.
        const un = agent.cliUnregister?.();
        if (un) deps.exec(un.bin, un.argv);
        const out = deps.exec(reg.bin, reg.argv);
        if (out !== null) rewritten.push(agent.id);
      }
      continue;
    }
    try {
      applyAgent(agent, py, false, launch);
      rewritten.push(agent.id);
    } catch {
      /* a malformed file we refused to clobber — skipped */
    }
  }
  return { rewritten, skipped: false };
}

/** The real seams (used by cli.ts). */
export function defaultVerifyDeps(): VerifyDeps {
  const resolvedServerJs = resolveServerJs();
  return {
    existsSync,
    readFileSync: (p) => readFileSync(p, "utf8"),
    realpath: realpathSync,
    exec: (bin, argv) => {
      try {
        return execFileSync(bin, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    },
    commandExists,
    resolvedServerJs,
    resolvedPy: process.env.PROMETHEUS_PY ?? "",
  };
}
