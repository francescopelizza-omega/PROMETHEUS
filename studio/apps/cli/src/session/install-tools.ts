import { agent } from "@prometheus/core";
/**
 * session/install-tools.ts — `/install <tool>`: add a missing external tool, gated.
 *
 * WHY THIS IS A SLASH COMMAND AND NOT A MODEL TOOL. It cannot be one. A package install is
 * unreachable from `run_command` at every authorization level including A7, by four
 * independent layers, and none of them is a bug to route around:
 *
 *   1. `sudo`, `doas`, `su` and every shell are in `FORBIDDEN` (agent/exec/registry.ts), as is
 *      every launcher (`env`, `timeout`, `nohup`, `xargs`) that would hide one.
 *   2. The exec sandbox confines writes to the working set; `/opt/homebrew`, `/usr/local` and
 *      `/opt` are not in it, so `brew install` fails even when fully approved.
 *   3. The sandbox denies the network below A5.
 *   4. A sandboxed child cannot exec a setuid binary.
 *
 * So the model's part is to SAY a tool is missing (the manifest in `agent/host-tools.ts` tells
 * it to), and the human's part is to type `/install`. That is the same division `propose_elevated`
 * already uses: it prints a command and executes nothing.
 *
 * WHAT MAKES IT SAFE TO RUN AT ALL:
 *
 *   - The id is looked up in `HOST_TOOLS`; a free-form string never reaches a package manager.
 *     (`modelhub.py`'s `_reject_unsafe_id` exists because an id that reaches argv and a filename
 *     is an injection surface. A closed catalog is the stronger version of the same guard.)
 *   - STAGE → GATE → INSTALL, the shape `main/ide/dap-adapter-install.ts` established: `brew
 *     fetch` downloads the bottle into brew's cache WITHOUT installing, nemesis scans the
 *     cached bytes, and only then does `brew install` run — consuming the same bytes that were
 *     scanned, never re-fetching different ones. Skipping the gate here is what prometheus.py's
 *     own installer calls "BYPASS #1".
 *   - A blocking verdict refuses. `verdict: "error"` (nemesis missing, timeout, unparseable)
 *     refuses too — it is fail-closed by definition, never a downgrade to "probably fine".
 *   - On Linux without root the command is PRINTED, not run. This repo refuses `sudo` at four
 *     layers; a slash command that shelled out to it anyway would be the fifth layer lying.
 */
import type { SecurityVerdict } from "@prometheus/engine-bridge";

type HostTool = agent.HostTool;
const { HOST_TOOLS, installPackage } = agent;

/** Capture the result of a command. Mirrors engine-bridge's `ExecCaptureResult`. */
export interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ToolSpawn = (cmd: string, args: string[]) => Promise<CaptureResult>;

export interface InstallDeps {
  /** shell-free capture (engine-bridge's `execCapture`, the C5-legal child_process owner). */
  spawn: ToolSpawn;
  /** nemesis on a real filesystem path. Never a bare package name — nemesis scans CONTENT. */
  gate: (target: string) => Promise<SecurityVerdict>;
  /** is a binary on PATH (the cached, spawn-free probe). */
  which: (bin: string) => string | null;
  platform?: NodeJS.Platform;
  /** euid 0. On Linux a non-root install is printed rather than run. */
  isRoot?: boolean;
}

export type InstallOutcome =
  | { kind: "already"; tool: HostTool; found: string }
  | { kind: "installed"; tool: HostTool; manager: string; pkg: string; verdict: SecurityVerdict }
  | { kind: "manual"; tool: HostTool; command: string; why: string }
  | { kind: "refused"; tool?: HostTool; error: string; verdict?: SecurityVerdict };

/** The supported managers, in the order they are probed. */
const MANAGERS: readonly string[] = ["brew", "apt-get", "dnf", "pacman"];

/** The first package manager on PATH, or null. */
export function detectPackageManager(which: (bin: string) => string | null): string | null {
  return MANAGERS.find((m) => which(m) !== null) ?? null;
}

/** Look an id up in the catalog. A name that is not in it never reaches a package manager. */
export function findHostTool(id: string): HostTool | null {
  const key = id.trim().toLowerCase();
  return (
    HOST_TOOLS.find((t) => t.id === key) ??
    HOST_TOOLS.find((t) => t.bins.some((b) => b === key)) ??
    null
  );
}

/** Does this verdict stop the install? `error` blocks too — that is what fail-closed means. */
export function verdictBlocks(v: SecurityVerdict): boolean {
  return v.verdict === "block" || v.verdict === "error";
}

/**
 * Install one catalog tool.
 *
 * Never throws: every failure is an `InstallOutcome` the command layer renders. The caller is
 * responsible for confirming with the human BEFORE calling this — by the time we are here the
 * decision has been made.
 */
export async function installHostTool(id: string, deps: InstallDeps): Promise<InstallOutcome> {
  const tool = findHostTool(id);
  if (!tool) {
    return {
      kind: "refused",
      error: `unknown tool "${id}" — /deps lists what can be installed`,
    };
  }
  const found = tool.bins.find((b) => deps.which(b) !== null);
  if (found) return { kind: "already", tool, found };

  const manager = detectPackageManager(deps.which);
  if (!manager) {
    return {
      kind: "refused",
      tool,
      error: "no supported package manager found (brew/apt/dnf/pacman)",
    };
  }
  const pkg = installPackage(tool, manager);
  if (!pkg) {
    return { kind: "refused", tool, error: `${manager} has no package for ${tool.id}` };
  }

  // Linux managers need root. This repo refuses `sudo` at four independent layers; printing the
  // line for the human to run is the same answer `propose_elevated` gives, and it is honest.
  if (manager !== "brew" && !deps.isRoot) {
    const verb = manager === "pacman" ? ["-S", "--noconfirm"] : ["install", "-y"];
    return {
      kind: "manual",
      tool,
      command: `sudo ${manager} ${verb.join(" ")} ${pkg}`,
      why: "installing system packages needs root, and Prometheus does not run sudo for you",
    };
  }

  if (manager === "brew") {
    // STAGE: download the bottle into brew's cache. `fetch` installs nothing.
    const fetched = await deps.spawn("brew", ["fetch", "--formula", pkg]);
    if (fetched.code !== 0) {
      return {
        kind: "refused",
        tool,
        error: `brew fetch ${pkg} failed: ${(fetched.stderr || fetched.stdout).trim().slice(0, 300)}`,
      };
    }
    // Where those bytes landed — asked of brew rather than guessed at.
    const cached = await deps.spawn("brew", ["--cache", "--formula", pkg]);
    const target = cached.stdout.trim().split("\n")[0] ?? "";
    if (cached.code !== 0 || !target) {
      return { kind: "refused", tool, error: `could not locate the downloaded bottle for ${pkg}` };
    }
    // GATE the staged bytes.
    const verdict = await deps.gate(target);
    if (verdictBlocks(verdict)) {
      return {
        kind: "refused",
        tool,
        verdict,
        error: `nemesis ${verdict.verdict} on the downloaded ${pkg} bottle — not installed`,
      };
    }
    // INSTALL from the cache that was just scanned.
    const installed = await deps.spawn("brew", ["install", pkg]);
    if (installed.code !== 0) {
      return {
        kind: "refused",
        tool,
        error: `brew install ${pkg} failed: ${(installed.stderr || installed.stdout).trim().slice(0, 300)}`,
      };
    }
    return { kind: "installed", tool, manager, pkg, verdict };
  }

  // Running as root on Linux: the same stage → gate → install shape, via the package cache.
  const dl = await deps.spawn(manager, ["install", "-y", "--download-only", pkg]);
  if (dl.code !== 0) {
    return {
      kind: "refused",
      tool,
      error: `${manager} download of ${pkg} failed: ${(dl.stderr || dl.stdout).trim().slice(0, 300)}`,
    };
  }
  const cacheDir = manager === "apt-get" ? "/var/cache/apt/archives" : "/var/cache";
  const verdict = await deps.gate(cacheDir);
  if (verdictBlocks(verdict)) {
    return {
      kind: "refused",
      tool,
      verdict,
      error: `nemesis ${verdict.verdict} on the downloaded ${pkg} package — not installed`,
    };
  }
  const done = await deps.spawn(manager, ["install", "-y", pkg]);
  if (done.code !== 0) {
    return {
      kind: "refused",
      tool,
      error: `${manager} install ${pkg} failed: ${(done.stderr || done.stdout).trim().slice(0, 300)}`,
    };
  }
  return { kind: "installed", tool, manager, pkg, verdict };
}
