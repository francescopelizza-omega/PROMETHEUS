// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/ls.ts — the `/ls` listing: what is in the directory this session is working in.
 *
 * The point of `/ls` is a quick, unambiguous answer to "is Prometheus pointed at the folder I
 * think it is?", so it lists the SESSION's cwd (`ctx.cwd()`, which `/cd` and `/cwd` move) and
 * never `process.cwd()` — the CLI never chdir's, so that stays the launch directory forever.
 *
 * Pure listing + formatting, no host seam, so both terminal hosts (raw TUI and readline) run
 * the identical code through the shared slash registry. It reads the directory itself with
 * `readdirSync`; it never shells out to the system `ls`.
 */
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { expandHome } from "@prometheus/core/agent-system-host";

import { shortCwd } from "../path-display.js";
import { c } from "../render.js";
import { stringWidth } from "../tui/width.js";

export interface LsEntry {
  name: string;
  isDir: boolean;
}

export type LsResult =
  | { ok: true; dir: string; entries: LsEntry[]; hidden: number }
  | { ok: false; dir: string; error: string };

/** More than this and the listing is cut with a count — a pane is not a file manager. */
export const LS_MAX_ENTRIES = 400;

/**
 * Parse `/ls` arguments: an optional path (relative to the session cwd, `~` expanded) and
 * `-a` / `--all` to include dotfiles. Anything else that starts with `-` is an error, so a
 * typo'd flag is never taken for a directory name.
 */
export function parseLsArgs(
  rest: string,
  cwd: string,
): { ok: true; dir: string; all: boolean } | { ok: false; error: string } {
  let all = false;
  const paths: string[] = [];
  for (const tok of rest.trim().split(/\s+/).filter(Boolean)) {
    if (tok === "-a" || tok === "--all") all = true;
    else if (tok.startsWith("-"))
      return { ok: false, error: `unknown option ${tok} — try /ls [path] [-a]` };
    else paths.push(tok);
  }
  if (paths.length > 1) return { ok: false, error: "one directory at a time — /ls [path] [-a]" };
  const target = paths[0] ? resolve(cwd, expandHome(paths[0])) : cwd;
  return { ok: true, dir: target, all };
}

/** Read one directory level: directories first, then files, each alphabetical. Never throws. */
export function listDirectory(dir: string, opts: { all?: boolean } = {}): LsResult {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const error =
      code === "ENOENT"
        ? `no such directory: ${dir}`
        : code === "ENOTDIR"
          ? `not a directory: ${dir}`
          : code === "EACCES" || code === "EPERM"
            ? `permission denied: ${dir}`
            : `cannot read ${dir}: ${(e as Error).message}`;
    return { ok: false, dir, error };
  }
  let hidden = 0;
  const entries: LsEntry[] = [];
  for (const name of names) {
    if (!opts.all && name.startsWith(".")) {
      hidden++;
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(resolve(dir, name)).isDirectory(); // follows symlinks, like `ls -F`'s target
    } catch {
      /* a dangling symlink or a vanished entry is listed as a plain name */
    }
    entries.push({ name, isDir });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { ok: true, dir, entries, hidden };
}

/**
 * Render a listing as transcript lines: a header naming the directory and the counts, then the
 * entries in COLUMN-major order (down, then across — the way `ls` reads) fitted to `width`.
 * Every entry line is indented, so the TUI's markdown pass never mistakes a name for a heading
 * or a list item.
 */
export function formatListing(result: LsResult, width: number): string[] {
  if (!result.ok) return [c.red(result.error)];
  const { entries, hidden } = result;
  const dirs = entries.filter((e) => e.isDir).length;
  const files = entries.length - dirs;
  const counts = [
    `${dirs} dir${dirs === 1 ? "" : "s"}`,
    `${files} file${files === 1 ? "" : "s"}`,
    ...(hidden > 0 ? [`${hidden} hidden (/ls -a)`] : []),
  ].join(", ");
  const lines = [`${c.bold(shortCwd(result.dir))}  ${c.dim(counts)}`];
  if (entries.length === 0) {
    lines.push(c.dim("  (empty)"));
    return lines;
  }
  const shown = entries.slice(0, LS_MAX_ENTRIES);
  const labels = shown.map((e) => (e.isDir ? `${e.name}/` : e.name));
  const gap = 2;
  const indent = 2;
  const colWidth = Math.max(...labels.map(stringWidth)) + gap;
  const usable = Math.max(20, width - indent);
  const cols = Math.max(1, Math.floor((usable + gap) / colWidth));
  const rows = Math.ceil(shown.length / cols);
  for (let r = 0; r < rows; r++) {
    let line = " ".repeat(indent);
    for (let k = 0; k < cols; k++) {
      const i = k * rows + r;
      const label = labels[i];
      const entry = shown[i];
      if (label === undefined || entry === undefined) break;
      const last = k === cols - 1 || (k + 1) * rows + r >= shown.length;
      const painted = entry.isDir ? c.cyan(label) : label;
      line += last ? painted : painted + " ".repeat(colWidth - stringWidth(label));
    }
    lines.push(line);
  }
  if (entries.length > shown.length) {
    lines.push(c.dim(`  … and ${entries.length - shown.length} more`));
  }
  return lines;
}
