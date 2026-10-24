// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/requirements-cmd.ts — `prometheus requirements`: what this machine needs for
 * Prometheus at full potential, the exact command for THIS operating system, and an offer to run
 * it.
 *
 * install.sh asks this before it installs anything. Everyone who got Prometheus another way —
 * a checkout through `bin/prometheus`, `pnpm dev:cli`, a machine that already had Node — never
 * saw that scan; this is the same question, asked from the CLI, with the same package lists
 * (`onboarding/system-packages.ts`, pinned against install.sh by both test suites).
 *
 * HOW IT RUNS ROOT: through the privileged gate, and only there — the one code path allowed to
 * start an elevated process. Each step (`apt-get update`, then `apt-get install …`) is shown
 * verbatim and approved by the human at this terminal, once, every time; sudo then asks for the
 * password on the terminal itself. Nothing here pre-approves, remembers or skips that. Homebrew
 * needs no root and runs on this terminal after a y/N. Homebrew ITSELF is not installed from here:
 * its installer runs sudo on its own authority, which no Prometheus code may start — install.sh
 * (your shell, your consent) offers it, scanned by nemesis first.
 *
 * `--check` (or no terminal, or --json) prints and changes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { onboarding } from "@prometheus/core";
import {
  type PrivilegedGate,
  createPrivilegedGate,
  lookPath,
  probeBwrap,
  scanCommand,
  verdictBlocks,
} from "@prometheus/core/agent-system-host";
import { probeSystemCommand, verdictReasons } from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "../context.js";
import { prometheusHome } from "../home.js";
import { runOnThisTerminal } from "../pty/backend.js";
import { c } from "../render.js";
import { makeTerminalApprover } from "../session/privileged-prompt.js";

/** The floor the CLI and install.sh share (apps/cli/package.json `engines.node`). */
const MIN_NODE: readonly [number, number] = [22, 6];

export interface RequirementsDeps {
  platform: NodeJS.Platform;
  osRelease: () => string | null;
  which: (bin: string) => string | null;
  /** a desktop session (and so a Secret Service) is running */
  desktop: boolean;
  /** /run/ostree-booted: an image-based Fedora */
  ostree: boolean;
  nodeVersion: string;
  /** the Python the engine would run, as "3.12.3", or null when there is none */
  pythonVersion: () => Promise<string | null>;
  /** null when this bwrap can create a sandbox here, else why not */
  bwrapBlocked: (bin: string) => string | null;
  /** stdin and stdout are a terminal: a human is there to ask */
  interactive: boolean;
  write: (line: string) => void;
  confirm: (prompt: string) => Promise<boolean>;
  /** the privileged gate (built lazily: only an install needs it) */
  gate: () => PrivilegedGate;
  /** run one command on this terminal, stdio inherited (Homebrew) */
  runOnTerminal: (argv: readonly string[]) => Promise<number>;
  /** install.sh beside the engine, for the macOS-without-Homebrew advice */
  installScript: string | null;
  /** chunks of a gated step's output, as they arrive */
  onOutput: (chunk: string) => void;
}

function versionAtLeast(v: string, [maj, min]: readonly [number, number]): boolean {
  const [a, b] = v.split(".").map((n) => Number.parseInt(n, 10));
  if (a === undefined || Number.isNaN(a)) return false;
  return a > maj || (a === maj && (b ?? 0) >= min);
}

type RowState = "ok" | "missing" | "optional" | "blocked";
interface Row {
  state: RowState;
  name: string;
  detail: string;
}

function mark(s: RowState): string {
  if (s === "ok") return c.green("ok      ");
  if (s === "optional") return c.dim("optional");
  return c.yellow(s === "blocked" ? "blocked " : "missing ");
}

function label(pkgs: readonly onboarding.SysPackage[]): string {
  const ids = pkgs.map((p) => p.id);
  if (ids.length <= 1) return ids.join("");
  return `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

/** `prometheus requirements [--check]` */
export async function runRequirements(
  ctx: CliContext,
  deps: RequirementsDeps = defaultRequirementsDeps(),
): Promise<CommandOutcome> {
  const report = onboarding.scanSystemPackages({
    platform: deps.platform,
    osRelease: deps.osRelease(),
    which: deps.which,
    desktop: deps.desktop,
    ostree: deps.ostree,
  });
  const rows: Row[] = [];
  rows.push(
    versionAtLeast(deps.nodeVersion, MIN_NODE)
      ? { state: "ok", name: "node", detail: deps.nodeVersion }
      : {
          state: "missing",
          name: "node",
          detail: `${deps.nodeVersion} is older than ${MIN_NODE.join(".")} — re-run install.sh, which fetches a private Node.js`,
        },
  );
  const py = await deps.pythonVersion().catch(() => null);
  rows.push(
    py
      ? { state: "ok", name: "python", detail: py }
      : {
          state: "missing",
          name: "python",
          detail:
            "no Python >= 3.9 — the engine and nemesis need it (install.sh fetches a private one)",
        },
  );
  const rg = deps.which("rg");
  rows.push(
    rg
      ? { state: "ok", name: "ripgrep", detail: rg }
      : {
          state: "missing",
          name: "ripgrep",
          detail: "the agent's file search (glob/grep) — install.sh fetches a private one",
        },
  );
  let blockedWhy: string | null = null;
  for (const r of report.rows) {
    if (r.found === null) {
      rows.push({
        state: r.pkg.tier === "optional" ? "optional" : "missing",
        name: r.pkg.id,
        detail: r.pkg.why,
      });
      continue;
    }
    if (r.pkg.id === "bubblewrap") {
      blockedWhy = deps.bwrapBlocked(r.found);
      if (blockedWhy !== null) {
        rows.push({
          state: "blocked",
          name: r.pkg.id,
          detail: `installed, but this host does not let it create a sandbox (${blockedWhy}); commands run unconfined`,
        });
        continue;
      }
    }
    rows.push({ state: "ok", name: r.pkg.id, detail: r.found });
  }

  const elevator = report.manager && onboarding.needsRoot(report.manager) ? "sudo" : null;
  const command = report.steps ? onboarding.commandLine(report.steps, elevator) : null;
  if (ctx.json) {
    return {
      json: {
        ok: report.missing.length === 0,
        distro: report.distro,
        manager: report.manager,
        rows,
        missing: report.missing.map((p) => p.id),
        command,
        needsHomebrew: report.needsHomebrew,
      },
      exitCode: 0,
    };
  }

  const out: string[] = [];
  out.push(
    `${c.bold("Requirements")} ${c.dim(`— ${report.distro.name}${report.manager ? ` · ${report.manager}` : ""}`)}`,
  );
  for (const r of rows) out.push(`  ${mark(r.state)} ${r.name.padEnd(12)} ${r.detail}`);
  if (blockedWhy !== null) {
    out.push(
      c.dim(
        "  bubblewrap: Ubuntu 24.04+ restricts unprivileged user namespaces; an AppArmor profile for /usr/bin/bwrap that allows `userns` restores the sandbox (install.sh --check prints it)",
      ),
    );
  }
  const flush = (): void => {
    for (const l of out.splice(0)) deps.write(l);
  };

  if (report.missing.length === 0) {
    out.push(c.green("  nothing to add from the system"));
    flush();
    return { text: "", exitCode: 0 };
  }
  out.push("");
  if (report.needsHomebrew) {
    out.push(`  On macOS, ${label(report.missing)} come from Homebrew, which is not installed.`);
    if (deps.installScript) {
      out.push(
        `  ${c.bold(`sh ${deps.installScript} --deps`)} offers Homebrew's official installer (scanned by nemesis first) and then the rest,`,
      );
      out.push("  or install Homebrew yourself from https://brew.sh, then:");
    } else {
      out.push("  Install Homebrew from https://brew.sh, then:");
    }
    out.push(
      `    ${c.bold(`brew install ${report.missing.flatMap((p) => p.names.brew ?? []).join(" ")}`)}`,
    );
    flush();
    return { text: "", exitCode: 0 };
  }
  if (!report.steps || !report.manager || command === null) {
    out.push(
      `${c.yellow(`  no supported package manager found here for ${label(report.missing)}`)} — install them with your system's tools`,
    );
    flush();
    return { text: "", exitCode: 0 };
  }
  out.push(`  To add ${label(report.missing)} on ${report.distro.name}:`);
  out.push(`    ${c.bold(command)}`);
  const check = ctx.args.flags.check === true;
  if (check || !deps.interactive) {
    out.push(
      c.dim(
        check
          ? "  --check: nothing was changed."
          : "  no terminal to ask on: run it yourself, or run `prometheus requirements` in a terminal",
      ),
    );
    flush();
    return { text: "", exitCode: 0 };
  }
  flush();

  const manager = report.manager;
  if (!onboarding.needsRoot(manager)) {
    if (!(await deps.confirm("Run it now? [y/N]"))) {
      deps.write(c.dim("  nothing changed"));
      return { text: "", exitCode: 0 };
    }
    for (const step of report.steps) {
      const code = await deps.runOnTerminal(step);
      if (code !== 0) {
        deps.write(c.red(`  ${step.join(" ")} failed (exit ${code})`));
        return { text: "", exitCode: 1 };
      }
    }
  } else {
    // Each step goes to the gate on its own: it shows the exact line, asks once, and sudo then
    // asks for the password on this terminal. A denial stops here — nothing half-runs.
    deps.write(
      c.dim("  each step is shown by the privileged gate and runs only if you approve it;"),
    );
    deps.write(c.dim("  sudo then asks for your password in this terminal."));
    const gate = deps.gate();
    for (const step of report.steps) {
      const res = await gate.requestAndRun(
        {
          argv: step,
          cwd: "/",
          why: `install ${label(report.missing)} for Prometheus (prometheus requirements)`,
          surface: "cli",
          requester: "prometheus requirements",
        },
        { onOutput: (chunk) => deps.onOutput(chunk) },
      );
      if (res.decision !== "approved") {
        deps.write(
          c.yellow(
            `  not run (${res.decision})${res.reason ? `: ${res.reason}` : ""} — nothing more was attempted`,
          ),
        );
        return { text: "", exitCode: 1 };
      }
      if (!res.ok) {
        deps.write(c.red(`  ${step.join(" ")} failed (exit ${res.exitCode ?? "?"})`));
        return { text: "", exitCode: 1 };
      }
    }
  }
  const after = onboarding.scanSystemPackages({
    platform: deps.platform,
    osRelease: deps.osRelease(),
    which: deps.which,
    desktop: deps.desktop,
    ostree: deps.ostree,
  });
  if (after.missing.length === 0) {
    deps.write(c.green(`  ✓ ${label(report.missing)} installed`));
    return { text: "", exitCode: 0 };
  }
  deps.write(
    c.yellow(`  still missing: ${label(after.missing)} (open a new terminal if PATH changed)`),
  );
  return { text: "", exitCode: 1 };
}

/* ── the real machine ─────────────────────────────────────────────────────── */

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let done = false;
    const finish = (v: string): void => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    // EOF denies: a closed stdin must never read as a yes
    rl.on("close", () => finish(""));
    rl.question(`${prompt} `, (a) => finish(a));
  });
}

async function ttyConfirm(prompt: string): Promise<boolean> {
  return /^y(es)?$/i.test((await readLine(prompt)).trim());
}

/** Is `/usr/bin/python3` on this Mac only the Command Line Tools stub? Running it opens a dialog. */
async function macStub(path: string, platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== "darwin" || path !== "/usr/bin/python3") return false;
  return (await probeSystemCommand("xcode-select", ["-p"])) === null;
}

export function defaultRequirementsDeps(): RequirementsDeps {
  const platform = process.platform;
  const which = (b: string): string | null => lookPath(b);
  const py = process.env.PROMETHEUS_PY;
  const script = py ? join(dirname(py), "install.sh") : null;
  return {
    platform,
    osRelease: () => {
      for (const f of ["/etc/os-release", "/usr/lib/os-release"]) {
        try {
          return readFileSync(f, "utf8");
        } catch {
          /* next */
        }
      }
      return null;
    },
    which,
    desktop: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_CURRENT_DESKTOP),
    ostree: existsSync("/run/ostree-booted"),
    nodeVersion: process.versions.node,
    pythonVersion: async () => {
      const p = which("python3");
      if (!p || (await macStub(p, platform))) return null;
      const out = await probeSystemCommand(p, [
        "-c",
        "import sys; print('%d.%d.%d' % sys.version_info[:3]) if sys.version_info >= (3, 9) else None",
      ]);
      const v = out?.trim();
      return v && /^\d+\.\d+\.\d+$/.test(v) ? `${v}  ${p}` : null;
    },
    bwrapBlocked: (bin) => probeBwrap(bin),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    write: (l) => void process.stdout.write(`${l}\n`),
    confirm: ttyConfirm,
    gate: () =>
      createPrivilegedGate({
        passwordVia: "tty",
        approver: makeTerminalApprover({
          write: (l) => void process.stdout.write(`${l}\n`),
          confirm: ttyConfirm,
          ask: readLine,
        }),
        home: prometheusHome(),
        userHome: homedir(),
        scan: async (line) => {
          const v = await scanCommand(line);
          return verdictBlocks(v, "enforce")
            ? { blocked: true, reason: verdictReasons(v).join("; ") || v.verdict }
            : { blocked: false };
        },
      }),
    runOnTerminal: async (argv) => {
      const [cmd, ...args] = argv;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
      const r = await runOnThisTerminal({ shell: cmd as string, args, cwd: process.cwd(), env });
      return r.exitCode;
    },
    installScript: script && existsSync(script) ? script : null,
    onOutput: (chunk) => void process.stdout.write(chunk),
  };
}
