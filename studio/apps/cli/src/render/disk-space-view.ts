// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * render/disk-space-view.ts — the text views of `/disk-space` (pure: data in, lines out).
 *
 * The full curses explorer is disk_space.py's own TUI (shown as an overlay); these are the
 * plain views every surface can print — the TUI's transcript, `--plain`, and one-shot
 * `prometheus disk-space`: the size tree with size / % / bar / items columns, the
 * `du --max-depth` levels, the largest files, the mounted filesystems, a delete plan, and the
 * Linux cleanup findings.
 */
import type {
  DiskCleanupFinding,
  DiskDeleteResult,
  DiskFile,
  DiskMount,
  DiskTreeNode,
} from "@prometheus/engine-bridge";
import { c, humanBytes, table } from "../render.js";

/** A proportional bar of `width` cells. */
export function bar(fraction: number, width = 20): string {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const full = Math.round(f * width);
  return "█".repeat(full) + "░".repeat(width - full);
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "—";
}

function flags(n: DiskTreeNode): string {
  const out: string[] = [];
  if (n.mount) out.push("other filesystem");
  if (n.unreadable) out.push("unreadable");
  if (n.frontier) out.push("deeper not measured");
  return out.length ? c.dim(` (${out.join(", ")})`) : "";
}

/**
 * The size tree: the root, then its children biggest first (and theirs, to `depth`), each with
 * size, share of the root, a bar, and the number of items below it.
 */
export function renderTree(
  root: DiskTreeNode,
  opts: { depth?: number; barWidth?: number } = {},
): string[] {
  const depth = Math.max(1, opts.depth ?? 2);
  const width = opts.barWidth ?? 20;
  const rows: string[][] = [];
  const walk = (n: DiskTreeNode, level: number): void => {
    for (const child of n.children ?? []) {
      rows.push([
        humanBytes(child.size),
        pct(child.size, root.size),
        bar(root.size > 0 ? child.size / root.size : 0, width),
        child.items !== undefined ? String(child.items) : "",
        `${"  ".repeat(level - 1)}${child.name}${child.dir ? "/" : ""}${flags(child)}`,
      ]);
      if (level < depth) walk(child, level + 1);
    }
    if (n.more)
      rows.push(["", "", "", "", `${"  ".repeat(level - 1)}${c.dim(`… ${n.more} more`)}`]);
  };
  walk(root, 1);
  return [
    `${c.bold(root.path)}  ${humanBytes(root.size)}`,
    table(
      [
        { header: "size", align: "right" },
        { header: "%", align: "right" },
        { header: "" },
        { header: "items", align: "right" },
        { header: "name" },
      ],
      rows,
    ),
  ];
}

export function renderMounts(mounts: readonly DiskMount[]): string[] {
  const rows = mounts.map((m) => [
    m.target,
    m.fstype,
    humanBytes(m.total),
    humanBytes(m.used),
    humanBytes(m.free),
    `${Math.round(m.usePct)}%`,
    bar(m.usePct / 100, 16),
  ]);
  return [
    table(
      [
        { header: "mounted on" },
        { header: "type" },
        { header: "size", align: "right" },
        { header: "used", align: "right" },
        { header: "free", align: "right" },
        { header: "use", align: "right" },
        { header: "" },
      ],
      rows,
    ),
  ];
}

export function renderLevels(
  levels: readonly { depth: number; rows: readonly { path: string; size: number }[] }[],
): string[] {
  const out: string[] = [];
  for (const lv of levels) {
    out.push(c.bold(`depth ${lv.depth}`) + c.dim(`  (du --max-depth=${lv.depth} | sort -rh)`));
    for (const r of lv.rows) out.push(`  ${humanBytes(r.size).padStart(8)}  ${r.path}`);
  }
  return out;
}

export function renderFiles(files: readonly DiskFile[]): string[] {
  return files.map((f) => `${humanBytes(f.size).padStart(8)}  ${f.path}`);
}

export function renderDeletePlan(plan: DiskDeleteResult): string[] {
  const how = plan.mode === "permanent" ? c.red("delete permanently") : "move to Trash";
  const out = [`${c.bold("plan")}: ${how}`];
  for (const it of plan.items ?? []) {
    if (it.protected) {
      out.push(`  ${c.red("REFUSED")}  ${it.path} — ${it.protected}`);
      continue;
    }
    const size = `${it.sizeAtLeast ? "≥" : ""}${humanBytes(it.size)}`;
    out.push(
      `  ${String(it.risk ?? "?").padEnd(6)}  ${size.padStart(8)}  ${it.path}  ${c.dim(it.reason)}`,
    );
  }
  out.push(c.dim(`total ${humanBytes(plan.total ?? 0)} · nothing has been changed yet`));
  return out;
}

/** Findings, with every action numbered so a human can pick one. */
export function renderCleanup(findings: readonly DiskCleanupFinding[]): string[] {
  const out: string[] = [];
  let n = 0;
  for (const f of findings) {
    out.push(
      `${c.bold(f.title)} — ${humanBytes(f.reclaimable)} reclaimable of ${humanBytes(f.size)} · ${f.summary}`,
    );
    for (const a of f.actions) {
      n += 1;
      const tags = [
        a.risk,
        a.needsRoot ? "root" : "",
        a.recommended ? "recommended" : "",
        a.requiresReboot ? "reboot" : "",
      ]
        .filter(Boolean)
        .join(", ");
      out.push(
        `  ${n}) ${a.title} ${c.dim(`(${tags})`)}${a.command ? "" : c.dim(" — needs input; run it in the full TUI")}`,
      );
      for (const line of a.preview) out.push(`       ${c.dim(line)}`);
    }
  }
  return out;
}
