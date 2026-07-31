#!/usr/bin/env node
/**
 * cli.ts — prometheus-install
 *
 * Detects which AI agent CLIs are present and registers the one Prometheus MCP
 * server into each (merge-safe). Usage:
 *   prometheus-install                 # all detected agents, user scope
 *   prometheus-install --agent claude  # one agent
 *   prometheus-install --dry-run       # show the plan, write nothing
 *   prometheus-install --py /abs/prometheus.py   # override PROMETHEUS_PY
 *   prometheus-install --list          # list known agents + detection state
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  AGENTS, present, commandExists, AgentTarget,
  LaunchMode, resolveServerJs, buildLaunch,
} from "./agents.js";
import { applyAgent, WriteResult } from "./writers.js";
import { defaultBootSmoke, defaultVerifyDeps, runRepair, runVerify } from "./verify.js";

interface Opts {
  agent: string; // "all" or an id
  dryRun: boolean;
  py: string;
  list: boolean;
  mode: LaunchMode;
  server: string; // explicit built server.js (local mode); "" = auto-resolve
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    agent: "all", dryRun: false, py: resolveDefaultPy(), list: false,
    mode: "local", server: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") o.agent = argv[++i];
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--list") o.list = true;
    else if (a === "--py") o.py = argv[++i];
    else if (a === "--mode") {
      const m = argv[++i];
      if (m !== "local" && m !== "npx") {
        process.stderr.write(`--mode must be 'local' or 'npx' (got '${m}')\n`);
        process.exit(2);
      }
      o.mode = m;
    } else if (a === "--server") o.server = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return o;
}

function resolveDefaultPy(): string {
  if (process.env.PROMETHEUS_PY) return process.env.PROMETHEUS_PY;
  const cands = [
    join(process.cwd(), "prometheus.py"),
    join(process.cwd(), "..", "prometheus.py"),
    join(homedir(), "ALPHA", "PROMETHEUS", "prometheus.py"),
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return join(homedir(), "ALPHA", "PROMETHEUS", "prometheus.py"); // best-effort default
}

function printHelp(): void {
  process.stdout.write(
    [
      "prometheus-install — register the Prometheus MCP server into your AI agent CLIs",
      "",
      "  prometheus-install [--agent <id|all>] [--mode local|npx] [--dry-run] [--py <path>] [--list]",
      "  prometheus-install verify [--agent <id>] [--json] [--no-smoke]   # check registrations + paths",
      "  prometheus-install repair [--agent <id>] [--yes] [--json]        # rewrite stale/absent (confirm)",
      "",
      "  --agent <id>   only this agent (claude|cursor|codex|gemini|windsurf|zed|continue|cline)",
      "  --mode <m>     local (default): launch the built server via `node <abs>/dist/server.js`",
      "                 — works today, no npm publish. npx: launch `npx -y @prometheus-plugin/mcp`",
      "                 — needs the packages published to npm first.",
      "  --server <p>   explicit path to the built mcp-server/dist/server.js (local mode)",
      "  --dry-run      print the plan; write nothing",
      "  --py <path>    absolute path to prometheus.py (else auto-detected / $PROMETHEUS_PY)",
      "  --list         show known agents and whether each is detected",
      "",
    ].join("\n"),
  );
}

/** A one-shot y/N confirm on the TTY (default N; non-TTY/EOF ⇒ decline). */
function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  process.stderr.write(`${question}\nproceed? [y/N] `);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const done = (v: boolean): void => {
      stdin.off("data", onData);
      try {
        stdin.pause();
      } catch {
        /* already paused */
      }
      resolve(v);
    };
    const onData = (d: Buffer): void => done(/^y(es)?$/i.test(d.toString().trim()));
    try {
      stdin.resume();
    } catch {
      resolve(false);
      return;
    }
    stdin.once("data", onData);
  });
}

/** `prometheus-install verify|repair` (CLI-056): registration health + fixable-path repair. */
async function verifyMain(mode: "verify" | "repair", argv: string[]): Promise<void> {
  const json = argv.includes("--json");
  const yes = argv.includes("--yes");
  const noSmoke = argv.includes("--no-smoke");
  const agentFlag = argv[argv.indexOf("--agent") + 1];
  const only = argv.includes("--agent") && agentFlag && !agentFlag.startsWith("-") ? agentFlag : null;
  const deps = defaultVerifyDeps();
  if (!deps.resolvedPy) deps.resolvedPy = resolveDefaultPy();
  const agents = only ? AGENTS.filter((a) => a.id === only) : AGENTS.filter(present);

  const result = await runVerify(agents, deps, {
    smoke: !noSmoke,
    boot: defaultBootSmoke,
  });

  if (mode === "verify") {
    if (json) process.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`);
    else process.stdout.write(`${result.text}\n`);
    process.exit(result.exitCode);
  }

  // repair: rewrite fixable findings behind a confirm (auto-no on non-TTY unless --yes).
  const confirm = (plan: string): Promise<boolean> => {
    process.stdout.write(`${result.text}\n\n`);
    return yes ? Promise.resolve(true) : promptYesNo(plan);
  };
  const { rewritten, skipped } = await runRepair(agents, result.findings, deps, confirm);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, rewritten, skipped }, null, 2)}\n`);
  } else if (skipped) {
    process.stdout.write("repair cancelled — nothing written.\n");
  } else if (rewritten.length === 0) {
    process.stdout.write("nothing to repair — all registrations healthy.\n");
  } else {
    process.stdout.write(`repaired: ${rewritten.join(", ")}\n`);
  }
  process.exit(0);
}

function main(): void {
  // verify/repair subcommands take precedence over the default install flow (CLI-056).
  const sub = process.argv[2];
  if (sub === "verify" || sub === "repair") {
    void verifyMain(sub, process.argv.slice(3));
    return;
  }

  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) {
    process.stdout.write("Known agents (● detected · ○ absent):\n");
    for (const t of AGENTS) {
      const dot = present(t) ? "●" : "○";
      process.stdout.write(`  ${dot} ${t.id.padEnd(10)} ${t.label.padEnd(22)} → ${t.configPath}\n`);
    }
    return;
  }

  if (!existsSync(opts.py)) {
    process.stderr.write(
      `WARNING: prometheus.py not found at ${opts.py}. ` +
        `The manifests will still be written; set PROMETHEUS_PY or pass --py.\n`,
    );
  }

  // Resolve how the agents will launch the server, and fail loudly in local mode
  // if the built server.js is missing (the #1 "installed but nothing starts" trap).
  const serverJs = opts.server || resolveServerJs();
  if (opts.mode === "local" && !existsSync(serverJs)) {
    process.stderr.write(
      `ERROR: local mode needs the built MCP server, not found at:\n  ${serverJs}\n` +
        `Build it first:  cd ${join(serverJs, "..", "..")} && npm install && npm run build\n` +
        `Or pass --server <abs path to dist/server.js>, or use --mode npx after publishing.\n`,
    );
    process.exit(2);
  }
  const launch = buildLaunch(opts.mode, serverJs);

  const chosen: AgentTarget[] =
    opts.agent === "all" ? AGENTS.filter(present) : AGENTS.filter((t) => t.id === opts.agent);

  if (chosen.length === 0) {
    process.stderr.write(
      opts.agent === "all"
        ? "No supported AI agent CLIs detected. Use --list to see what is probed.\n"
        : `Unknown or undetected agent: ${opts.agent}. Use --list.\n`,
    );
    process.exit(1);
  }

  const results: WriteResult[] = [];
  for (const t of chosen) {
    try {
      // prefer the agent's own CLI registrar (e.g. `claude mcp add`) when present
      const reg = t.cliRegister?.(opts.py, launch);
      if (reg && commandExists(reg.bin)) {
        if (opts.dryRun) {
          process.stderr.write(`  (dry-run) ${reg.bin} ${reg.argv.join(" ")}\n`);
          results.push({ agent: t.id, path: `${reg.bin} mcp add`, action: "skipped", note: t.note });
        } else {
          execFileSync(reg.bin, reg.argv, { stdio: "ignore" });
          results.push({ agent: t.id, path: `${reg.bin} mcp add`, action: "written", note: t.note });
        }
        continue;
      }
      results.push(applyAgent(t, opts.py, opts.dryRun, launch));
    } catch (e) {
      process.stderr.write(`  ! ${t.id}: ${(e as Error).message}\n`);
    }
  }

  process.stdout.write(
    `\nPrometheus MCP server → ${opts.dryRun ? "(dry-run, nothing written)" : "registered"}:\n`,
  );
  for (const r of results) {
    process.stdout.write(`  ${r.action.padEnd(8)} ${r.agent.padEnd(10)} ${r.path}\n`);
    process.stdout.write(`           next: ${r.note}\n`);
  }
  process.stdout.write(`\nengine: ${opts.py}\n`);
  process.stdout.write(`launch: [${opts.mode}] ${launch.command} ${launch.args.join(" ")}\n`);
}

main();
