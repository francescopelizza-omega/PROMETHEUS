// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/disk-space-cmd.ts — `/disk-space` and `prometheus disk-space`.
 *
 *   /disk-space [PATH]           disk_space.py's own curses TUI — shown OVER the session in the
 *                                TUI (Ctrl+] minimises it without stopping it, Ctrl+] at the
 *                                prompt shows it again, Ctrl+D inside it ends it); the real
 *                                terminal handed over in `--plain`. PATH opens its map there.
 *   /disk-space map [PATH]       the size tree: size, %, bar, items
 *   /disk-space levels [PATH]    `du --max-depth=N | sort -rh` for N = 1..depth
 *   /disk-space files [PATH]     the largest files
 *   /disk-space mounts           filesystems: size, used, free
 *   /disk-space delete PATH…     a plan, then y/N (and a typed `yes` when it is high-risk)
 *   /disk-space cleanup          Linux cleanup findings; a picked root action goes through
 *                                the privileged gate
 *   /disk-space --sudo [PATH]    the same scan as root (default `/`), through the privileged
 *                                gate: the human approves that exact command first
 *
 * Nothing here elevates on its own. The tool always runs with `--no-sudo`; root work is an argv
 * handed to the privileged gate, and where no human is attached to approve it (one-shot,
 * `--json`) it is printed instead of run.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { shellQuote } from "@prometheus/core/agent-exec";
import type { PrivilegedGate, Surface } from "@prometheus/core/agent-system-host";
import {
  type DiskSpaceClient,
  type DiskToolPaths,
  type DiskTreeNode,
  createDiskSpaceClient,
  diskSpaceToolPaths,
  diskSpaceTuiArgv,
} from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "../context.js";
import { c } from "../render.js";
import {
  renderCleanup,
  renderDeletePlan,
  renderFiles,
  renderLevels,
  renderMounts,
  renderTree,
} from "../render/disk-space-view.js";
import type { OverlayLaunch } from "../tui/overlay-session.js";

export interface DiskSpaceIo {
  write(line: string): void;
  confirm(prompt: string): Promise<boolean>;
  ask(prompt: string): Promise<string>;
  cwd: string;
  /** the TUI: show the curses tool over the session */
  openOverlay?(o: OverlayLaunch): "started" | "resumed" | "busy";
  /** `--plain`: hand the real terminal to the tool until it exits */
  handOver?(argv: string[], cwd: string): Promise<number | null>;
}

export interface DiskSpaceDeps {
  client: DiskSpaceClient;
  paths: DiskToolPaths;
  /** only on a surface with a human attached to approve; absent ⇒ root work is printed */
  gate?: PrivilegedGate;
  surface: Surface;
  toolExists?: (path: string) => boolean;
}

/** How much of a root rescan's stdout (its JSON map) to keep. */
export const ROOT_MAP_CAPTURE_BYTES = 64 * 1024 * 1024;

export const DISK_SPACE_USAGE = [
  "/disk-space [PATH]          the full disk explorer (Ctrl+] minimise/resume · Ctrl+D quit)",
  "/disk-space map [PATH]      size tree · levels [PATH] · files [PATH] · mounts",
  "/disk-space delete PATH…    plan, then confirm (--permanent instead of Trash)",
  "/disk-space cleanup         Linux cleanup (root actions ask you first)",
  "/disk-space --sudo [PATH]   the scan as root — you approve the exact command",
];

const SUBS = new Set(["map", "levels", "files", "mounts", "delete", "cleanup", "help"]);
const VALUE_FLAGS = new Set(["depth", "top", "max-nodes", "depth-cap"]);

function parse(args: readonly string[]): {
  sub: string;
  pos: string[];
  flags: Map<string, string>;
} {
  const flags = new Map<string, string>();
  const pos: string[] = [];
  let sub = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) flags.set(k, v);
      else if (VALUE_FLAGS.has(k) && i + 1 < args.length) flags.set(k, args[++i] as string);
      else flags.set(k, "");
      continue;
    }
    if (!sub && pos.length === 0 && SUBS.has(a)) sub = a;
    else pos.push(a);
  }
  return { sub, pos, flags };
}

function absPath(cwd: string, p: string): string {
  const expanded = p === "~" ? homedir() : p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p;
  return resolve(cwd, expanded);
}

function num(flags: Map<string, string>, k: string): number | undefined {
  const v = flags.get(k);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

function fail(io: DiskSpaceIo, what: string, error?: string): number {
  io.write(`  ⎿ ${c.red(`${what} failed`)}: ${error ?? "unknown error"}`);
  return 1;
}

function summaryLine(s: Record<string, unknown> | undefined): string | null {
  if (!s) return null;
  const parts = [
    s.survey_dirs !== undefined ? `${s.survey_dirs} folders` : "",
    s.seconds !== undefined ? `${s.seconds}s` : "",
    s.engine ? `engine ${s.engine}` : "",
  ].filter(Boolean);
  const unreadable = Number(s.unreadable ?? 0);
  if (unreadable > 0) {
    parts.push(
      `${unreadable} unreadable — /disk-space --sudo PATH measures them as root (you approve it first)`,
    );
  }
  return parts.length ? c.dim(parts.join(" · ")) : null;
}

async function explorer(
  path: string | undefined,
  io: DiskSpaceIo,
  deps: DiskSpaceDeps,
): Promise<number> {
  const exists = deps.toolExists ?? existsSync;
  if (!exists(deps.paths.tool) || !exists(deps.paths.ptyHost)) {
    return fail(io, "disk-space", `the disk tool is not shipped here (${deps.paths.tool})`);
  }
  const argv = diskSpaceTuiArgv(deps.paths, path);
  if (io.openOverlay) {
    const r = io.openOverlay({
      label: "disk-space",
      argv,
      python: deps.paths.python,
      ptyHost: deps.paths.ptyHost,
      cwd: io.cwd,
    });
    if (r === "busy") return fail(io, "disk-space", "another full-screen program is open");
    if (r === "resumed") io.write("  ⎿ resumed the running disk-space");
    return 0;
  }
  if (io.handOver) {
    io.write("  ⎿ disk-space has the terminal until you quit it (q)");
    const code = await io.handOver(argv, io.cwd);
    io.write(`  ⎿ disk-space closed${code ? ` (exit ${code})` : ""}`);
    return 0;
  }
  io.write(
    "  ⎿ the interactive explorer needs a terminal (prometheus TUI); here are the filesystems:",
  );
  return views("mounts", [], new Map(), io, deps);
}

async function views(
  sub: string,
  pos: string[],
  flags: Map<string, string>,
  io: DiskSpaceIo,
  deps: DiskSpaceDeps,
): Promise<number> {
  const path = absPath(io.cwd, pos[0] ?? ".");
  switch (sub) {
    case "map": {
      const maxNodes = num(flags, "max-nodes");
      const r = await deps.client.map(path, maxNodes ? { maxNodes } : {});
      if (!r.ok || !r.tree) return fail(io, "disk-space map", r.error);
      for (const l of renderTree(r.tree, { depth: num(flags, "depth") ?? 2 })) io.write(l);
      const s = summaryLine(r.summary as unknown as Record<string, unknown>);
      if (s) io.write(s);
      if (r.truncated) io.write(c.dim("(the smallest folders were left out of this view)"));
      return 0;
    }
    case "levels": {
      const r = await deps.client.levels(path, {
        depth: num(flags, "depth") ?? 3,
        top: num(flags, "top") ?? 10,
      });
      if (!r.ok) return fail(io, "disk-space levels", r.error);
      for (const l of renderLevels(r.levels ?? [])) io.write(l);
      return 0;
    }
    case "files": {
      const r = await deps.client.largestFiles(path, { top: num(flags, "top") ?? 25 });
      if (!r.ok) return fail(io, "disk-space files", r.error);
      for (const l of renderFiles(r.files ?? [])) io.write(l);
      return 0;
    }
    default: {
      const r = await deps.client.mounts();
      if (!r.ok) return fail(io, "disk-space mounts", r.error);
      for (const l of renderMounts(r.mounts ?? [])) io.write(l);
      return 0;
    }
  }
}

async function remove(
  pos: string[],
  flags: Map<string, string>,
  io: DiskSpaceIo,
  deps: DiskSpaceDeps,
): Promise<number> {
  if (pos.length === 0)
    return fail(io, "disk-space delete", "which path? /disk-space delete PATH…");
  const mode = flags.has("permanent") ? "permanent" : "trash";
  const paths = pos.map((p) => absPath(io.cwd, p));
  const plan = await deps.client.deletePlan(paths, { mode });
  if (!plan.ok) return fail(io, "disk-space delete", plan.error);
  for (const l of renderDeletePlan(plan)) io.write(l);
  const runnable = (plan.items ?? []).filter((i) => !i.protected);
  if (runnable.length === 0) return 1;
  const verb = mode === "permanent" ? "delete these permanently" : "move these to the Trash";
  if (!(await io.confirm(`${verb}?`))) {
    io.write("  ⎿ nothing changed");
    return 0;
  }
  const ack = plan.requiresPhrase === true;
  if (ack) {
    const typed = (
      await io.ask('this is high-risk or very large — type "yes" to go ahead:')
    ).trim();
    if (typed !== "yes") {
      io.write("  ⎿ nothing changed");
      return 0;
    }
  }
  const done = await deps.client.deleteConfirm(paths, { mode, ackHighRisk: ack });
  if (!done.ok) return fail(io, "disk-space delete", done.error);
  for (const r of done.results ?? [])
    io.write(`  ${r.ok ? c.green("✓") : c.red("✗")} ${r.path} — ${r.msg}`);
  return (done.results ?? []).every((r) => r.ok) ? 0 : 1;
}

function printProposal(io: DiskSpaceIo, argv: readonly string[]): void {
  io.write("  ⎿ this needs root, and nobody here can approve it, so nothing ran. The command:");
  io.write(`      sudo ${argv.map(shellQuote).join(" ")}`);
  io.write(
    "  ⎿ run /disk-space --sudo in the prometheus TUI to approve it there, or copy it into your terminal",
  );
}

async function asRoot(pos: string[], io: DiskSpaceIo, deps: DiskSpaceDeps): Promise<number> {
  const path = absPath(io.cwd, pos[0] ?? "/");
  const r = await deps.client.privilegedRescan(path);
  if (!r.ok || !r.argv) return fail(io, "disk-space --sudo", r.error);
  if (!deps.gate) {
    printProposal(io, r.argv);
    return 0;
  }
  const res = await deps.gate.requestAndRun(
    {
      argv: r.argv,
      cwd: r.cwd ?? "/",
      why: r.why ?? `measure ${path} as root`,
      surface: deps.surface,
      requester: "/disk-space --sudo",
    },
    // the whole map comes back on stdout — keep all of it, not the gate's 1 MiB default
    { captureBytes: ROOT_MAP_CAPTURE_BYTES },
  );
  if (res.decision !== "approved") {
    io.write(`  ⎿ not run (${res.decision})${res.reason ? `: ${res.reason}` : ""}`);
    return 1;
  }
  if (!res.ok)
    return fail(
      io,
      "the root scan",
      res.reason ?? res.stderr?.slice(-500) ?? `exit ${res.exitCode}`,
    );
  if (res.outputTruncated) {
    return fail(io, "the root scan", "its map was too large to keep — scan a deeper folder");
  }
  let parsed: { tree?: DiskTreeNode; summary?: Record<string, unknown> };
  try {
    parsed = JSON.parse(res.stdout ?? "");
  } catch {
    return fail(io, "the root scan", "its output was not the expected JSON");
  }
  if (!parsed.tree) return fail(io, "the root scan", "no tree in its output");
  for (const l of renderTree(parsed.tree, { depth: 2 })) io.write(l);
  return 0;
}

async function cleanup(io: DiskSpaceIo, deps: DiskSpaceDeps): Promise<number> {
  const r = await deps.client.cleanupPlan();
  if (!r.ok) return fail(io, "disk-space cleanup", r.error);
  if (r.note) io.write(`  ⎿ ${r.note}`);
  const findings = r.findings ?? [];
  if (findings.length === 0) {
    if (!r.note) io.write("  ⎿ nothing worth cleaning was found");
    return 0;
  }
  for (const l of renderCleanup(findings)) io.write(l);
  const actions = findings.flatMap((f) => f.actions.map((a) => ({ f, a })));
  if (!deps.gate) {
    io.write("  ⎿ these run as root: use /disk-space cleanup in the prometheus TUI to approve one");
    return 0;
  }
  const pick = (await io.ask("run which action? (number · Enter for none)")).trim();
  const chosen = actions[Number(pick) - 1];
  if (!pick || !chosen) return 0;
  if (!chosen.a.command)
    return fail(
      io,
      "disk-space cleanup",
      "this action needs input — run it in the full TUI (/disk-space)",
    );
  const res = await deps.gate.requestAndRun({
    argv: chosen.a.command,
    cwd: "/",
    why: `disk-space cleanup: ${chosen.f.title} — ${chosen.a.title}`,
    surface: deps.surface,
    requester: "/disk-space cleanup",
  });
  io.write(
    res.decision === "approved"
      ? `  ⎿ ${res.ok ? "done" : `failed (exit ${res.exitCode})`}: ${chosen.a.title}`
      : `  ⎿ not run (${res.decision})${res.reason ? `: ${res.reason}` : ""}`,
  );
  return res.ok ? 0 : 1;
}

/** The whole command, over an injected terminal and clients. Returns an exit code. */
export async function runDiskSpace(
  args: readonly string[],
  io: DiskSpaceIo,
  deps: DiskSpaceDeps,
): Promise<number> {
  const { sub, pos, flags } = parse(args);
  if (flags.has("sudo")) return asRoot(pos, io, deps);
  switch (sub) {
    case "help":
      for (const l of DISK_SPACE_USAGE) io.write(l);
      return 0;
    case "delete":
      return remove(pos, flags, io, deps);
    case "cleanup":
      return cleanup(io, deps);
    case "map":
    case "levels":
    case "files":
    case "mounts":
      return views(sub, pos, flags, io, deps);
    default:
      return explorer(pos[0] ? absPath(io.cwd, pos[0]) : undefined, io, deps);
  }
}

/** Default deps for a host: the real sidecar client and tool paths. */
export function defaultDiskSpaceDeps(surface: Surface, gate?: PrivilegedGate): DiskSpaceDeps {
  return {
    client: createDiskSpaceClient(),
    paths: diskSpaceToolPaths(),
    surface,
    ...(gate ? { gate } : {}),
  };
}

/**
 * One-shot `prometheus disk-space …` — no human-attached approver here, so root work is
 * printed, never run; `--json` prints the sidecar envelope of the native views.
 */
export async function runDiskSpaceCommand(ctx: CliContext): Promise<CommandOutcome> {
  const args = [
    ...(ctx.args.unmatchedSub ? [ctx.args.unmatchedSub] : ctx.args.command.slice(1)),
    ...Object.entries(ctx.args.flags ?? {}).flatMap(([k, v]) =>
      v === true ? [`--${k}`] : [`--${k}`, String(v)],
    ),
    ...ctx.args.positionals,
  ];
  const lines: string[] = [];
  const deps = defaultDiskSpaceDeps("cli");
  if (ctx.json) {
    const { sub, pos } = parse(args);
    const path = absPath(process.cwd(), pos[0] ?? ".");
    const env =
      sub === "map"
        ? await deps.client.map(path)
        : sub === "levels"
          ? await deps.client.levels(path)
          : sub === "files"
            ? await deps.client.largestFiles(path)
            : await deps.client.mounts();
    return { json: env as never, exitCode: env.ok ? 0 : 1 };
  }
  const code = await runDiskSpace(
    args,
    {
      cwd: process.cwd(),
      write: (l) => lines.push(l),
      // no prompts in a one-shot run: anything that would ask is answered "no"
      confirm: async () => false,
      ask: async () => "",
    },
    deps,
  );
  return { text: lines.join("\n"), exitCode: code };
}
