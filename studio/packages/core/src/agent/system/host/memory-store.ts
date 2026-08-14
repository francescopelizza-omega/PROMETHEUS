/**
 * agent/system/host/memory-store.ts — the durable cross-session memory store, in ONE place
 * (shared by CLI and desktop, same discipline as `grants-store.ts`'s "ONE FILE FOR BOTH
 * SURFACES" and `fs-mutate-host.ts`'s Tier-W implementation).
 *
 * LAYOUT: `<home>/memory/<project-key>/<slug>.md` (one file per TOPIC — create-or-update by
 * name, never a dated log) plus an auto-generated `<project-key>/index.md` that
 * `loadMemoryIndexBlock` folds into the system prompt and `memory_read` (no `topic`) returns
 * verbatim. The index is REBUILT from the actual topic files on every read/write rather than
 * trusted as its own source of truth — a stale index that drifted from the files it summarizes
 * would be worse than no index.
 *
 * PROJECT KEY: `sha256(repo root).slice(0, 16)`, the SAME derivation
 * `apps/desktop/src/main/ide/history-store.ts`'s `workspaceHash` already uses to name
 * per-workspace local-history files — reused rather than invented so "how does this repo turn
 * a path into a stable on-disk key" has one answer. The repo root is found by walking up from
 * `cwd` to the nearest `.git` (mirrors `apps/cli/src/session/steering.ts`'s `steeringDirs`
 * walk), so running from a package subdirectory of a monorepo still lands in the ONE memory
 * dir for that repo rather than fragmenting per-subdirectory.
 *
 * NODE-ONLY: the host half, alongside the other `system/host` modules.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  MEMORY_INDEX_FILE,
  type MemoryEntry,
  type MemoryWriteInput,
  entryFromParsed,
  memoryIndexBlock,
  parseMemoryFile,
  renderMemoryIndex,
  serializeMemoryEntry,
  slugify,
  validateMemoryWrite,
} from "../../../memory/index.js";
import type { ToolOutcome } from "../../loop.js";

/** A stable, filesystem-safe key for a project root (content-addressed, collision-safe) —
 *  the SAME derivation as desktop's `workspaceHash`. */
export function projectKey(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
}

/**
 * Walk up from `cwd` to the nearest `.git` directory — the repo boundary. Falls back to `cwd`
 * itself when no `.git` is found within a bounded depth (a non-repo working directory still
 * gets a stable, if narrower, memory scope rather than an error).
 */
export function memoryProjectRoot(
  cwd: string,
  exists: (p: string) => boolean = existsSync,
): string {
  let dir = resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd);
}

/** The project's memory directory: `<home>/memory/<project-key>`. */
export function memoryDir(home: string, cwd: string): string {
  return join(home, "memory", projectKey(memoryProjectRoot(cwd)));
}

/** Every valid topic file in `dir` (corrupt/hand-mangled files are skipped, not fatal). */
function readEntries(dir: string): MemoryEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  for (const n of names) {
    if (!n.endsWith(".md") || n === MEMORY_INDEX_FILE) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, n), "utf8");
    } catch {
      continue;
    }
    const entry = entryFromParsed(n.slice(0, -".md".length), parseMemoryFile(raw));
    if (entry) out.push(entry);
  }
  return out;
}

/** Rebuild `index.md` from the topic files on disk and return what it now lists.
 *  Fail-soft: a read-only home just means the NEXT read regenerates it again from memory. */
function regenerateIndex(dir: string): MemoryEntry[] {
  const entries = readEntries(dir);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MEMORY_INDEX_FILE), renderMemoryIndex(entries));
  } catch {
    /* the in-memory list is still correct; only the persisted copy failed to refresh */
  }
  return entries;
}

/**
 * The index folded into a system prompt, or null when this project has never had a memory
 * entry written (no directory ⇒ nothing to inject — a project that never uses `memory_write`
 * should never grow a `~/.prometheus/memory/*` entry for it).
 */
export function loadMemoryIndexBlock(home: string, cwd: string): string | null {
  const dir = memoryDir(home, cwd);
  if (!existsSync(dir)) return null;
  const entries = regenerateIndex(dir);
  if (entries.length === 0) return null;
  return memoryIndexBlock(renderMemoryIndex(entries));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `memory_write` — validate, then create-or-overwrite `<slug>.md` and refresh the index. */
export function writeMemoryEntry(
  home: string,
  cwd: string,
  args: Record<string, unknown>,
): ToolOutcome {
  const result = validateMemoryWrite(args as MemoryWriteInput);
  if (!result.ok) {
    return {
      ok: false,
      summary: `memory_write refused:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
    };
  }
  const dir = memoryDir(home, cwd);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${result.entry.slug}.md`), serializeMemoryEntry(result.entry));
  } catch (err) {
    return { ok: false, summary: `memory_write failed: ${errText(err)}` };
  }
  regenerateIndex(dir);
  return {
    ok: true,
    summary:
      `recorded "${result.entry.name}" under category "${result.entry.category}" ` +
      `(${result.entry.slug}.md) — ${result.why}`,
    data: { slug: result.entry.slug, category: result.entry.category },
  };
}

/** `memory_read` — no `topic` ⇒ the index; a `topic` ⇒ that one entry's full body. */
export function readMemoryEntry(home: string, cwd: string, topic: string): ToolOutcome {
  const dir = memoryDir(home, cwd);
  const t = topic.trim();
  if (!t) {
    const entries = existsSync(dir) ? regenerateIndex(dir) : [];
    // `count` lets a caller (e.g. the desktop pane's auto-load effect) tell "nothing recorded
    // yet" apart from "recorded, here it is" without string-matching the placeholder text.
    return { ok: true, summary: renderMemoryIndex(entries), data: { count: entries.length } };
  }
  if (!existsSync(dir)) {
    return {
      ok: false,
      summary: `memory_read: no memory recorded yet for this project (asked for "${t}")`,
    };
  }
  const wanted = slugify(t);
  const entries = readEntries(dir);
  const found = entries.find(
    (e) =>
      e.slug === t || (wanted && e.slug === wanted) || e.name.toLowerCase() === t.toLowerCase(),
  );
  if (!found) {
    return {
      ok: false,
      summary: `memory_read: no topic matching "${t}" — call memory_read with no topic to see the index`,
    };
  }
  return {
    ok: true,
    summary: `# ${found.name}\ncategory: ${found.category}\n\n${found.body}`,
    data: { slug: found.slug, category: found.category },
  };
}

/** Dispatch `memory_write`/`memory_read` by name, or null when it is neither. */
export function runMemoryTool(
  name: string,
  args: Record<string, unknown>,
  deps: { cwd: string; home: string },
): ToolOutcome | null {
  if (name === "memory_write") return writeMemoryEntry(deps.home, deps.cwd, args);
  if (name === "memory_read") {
    return readMemoryEntry(deps.home, deps.cwd, typeof args.topic === "string" ? args.topic : "");
  }
  return null;
}
