/**
 * session/steering.ts — discover + assemble AGENTS.md / CLAUDE.md / PROMETHEUS.md steering (CLI-061).
 *
 * The core `rules/` loader is PURE (no fs); THIS module is the apps/cli fs wrapper: it discovers the
 * project files (cwd) + global files (~/.prometheus) via an INJECTED read seam (testable), maps them
 * to core `RuleSource`s in DEFAULT_PRECEDENCE order, and assembles the system-context block the
 * agent-runtime injects. A file tripping `isRemoteInstruction` is flagged + NEVER folded into the
 * prompt (URL-injection posture). Reload is re-discovery + re-assembly — no restart.
 *
 * NOTE: core DEFAULT_PRECEDENCE is PROJECT-first (project agents → project claude → global …); the
 * listing follows that order. (The spec text said "global first" — that misreads the code; ground
 * truth wins.)
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { rules } from "@prometheus/core";

import { prometheusHome } from "../home.js";

type RuleScope = rules.RuleScope;
type RuleSource = rules.RuleSource;

/** One discovered steering file (richer than core RuleSource — carries listing metadata). */
export interface SteeringFile {
  /** absolute path. */
  path: string;
  scope: RuleScope;
  /** the base name: AGENTS.md | CLAUDE.md | PROMETHEUS.md. */
  name: string;
  /** exists + non-empty. */
  loaded: boolean;
  /** byte size (0 when absent). */
  size: number;
  content: string;
  /** the file carries a remote-fetch instruction (loader.isRemoteInstruction) — never auto-loaded. */
  remote: boolean;
}

/** The read seam: return the file's UTF-8 content, or null when absent/unreadable. Injectable. */
export type ReadSeam = (path: string) => string | null;

const defaultRead: ReadSeam = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Which steering base names exist per scope, in DEFAULT_PRECEDENCE-consistent order. */
const PROJECT_NAMES = ["AGENTS.md", "CLAUDE.md", "PROMETHEUS.md"] as const;
const GLOBAL_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Map a steering file name → the core RuleKind (PROMETHEUS.md folds into the "agents" chain). */
function kindOf(name: string): rules.RuleKind {
  return name === "CLAUDE.md" ? "claude" : "agents";
}

function toFile(path: string, scope: RuleScope, name: string, read: ReadSeam): SteeringFile {
  const content = read(path);
  if (content === null)
    return { path, scope, name, loaded: false, size: 0, content: "", remote: false };
  const remote = rules.isRemoteInstruction(content);
  return {
    path,
    scope,
    name,
    loaded: content.trim() !== "",
    size: content.length,
    content,
    remote,
  };
}

/**
 * Discover steering files (project cwd + global ~/.prometheus) in precedence order. Every candidate
 * is returned (loaded OR missing) so `/memory` can list + offer to create the missing ones.
 */
export function discoverSteering(
  cwd: string,
  home: string = prometheusHome(),
  read: ReadSeam = defaultRead,
): SteeringFile[] {
  const out: SteeringFile[] = [];
  for (const name of PROJECT_NAMES) out.push(toFile(join(cwd, name), "project", name, read));
  for (const name of GLOBAL_NAMES) out.push(toFile(join(home, name), "global", name, read));
  return out;
}

/** The loaded, NON-remote files as core RuleSources (the ones folded into the prompt). */
export function steeringToRuleSources(files: readonly SteeringFile[]): RuleSource[] {
  return files
    .filter((f) => f.loaded && !f.remote)
    .map((f) => ({ scope: f.scope, kind: kindOf(f.name), path: f.path, content: f.content }));
}

/** Assemble the loaded steering into ONE system-context block (empty string when none loaded). */
export function assembleSteering(files: readonly SteeringFile[]): string {
  const sources = steeringToRuleSources(files);
  return sources.length === 0 ? "" : rules.assembleRules(sources).text;
}

/** Render the `/memory` listing: one row per candidate — mark · scope · name · size/state · path. */
export function renderSteeringList(files: readonly SteeringFile[]): string[] {
  const rows = files.map((f) => {
    const mark = f.remote ? "⚠" : f.loaded ? "✓" : "·";
    const state = f.remote
      ? "REMOTE — not loaded (contains a fetch directive)"
      : f.loaded
        ? `${f.size} B`
        : "missing";
    return `  ${mark} [${f.scope.padEnd(7)}] ${f.name.padEnd(14)} ${state}\n      ${f.path}`;
  });
  const loaded = files.filter((f) => f.loaded && !f.remote).length;
  const head = `Steering files (${loaded} loaded · project cwd + ~/.prometheus, precedence order)`;
  const missing = files.some((f) => !f.loaded && !f.remote);
  const tail = missing ? "\n  · missing files can be created: /memory create" : "";
  return [head, ...rows, tail].filter((l) => l !== "");
}

/** A one-line active-steering badge (count + scopes), or "" when nothing is loaded. */
export function steeringBadge(files: readonly SteeringFile[]): string {
  const loaded = files.filter((f) => f.loaded && !f.remote);
  if (loaded.length === 0) return "";
  const scopes = [...new Set(loaded.map((f) => f.scope))].sort().join("+");
  return `steering: ${loaded.length} file${loaded.length === 1 ? "" : "s"} (${scopes})`;
}

/* ── the /memory controller (shared by both hosts) ───────────────────────────── */

/** Resolve a `/memory edit` target: a 1-based index into the list, or a path/name match. */
export function resolveSteeringTarget(
  files: readonly SteeringFile[],
  target: string,
): SteeringFile | undefined {
  const t = target.trim();
  if (/^\d+$/.test(t)) return files[Number(t) - 1];
  return files.find(
    (f) => f.path === t || f.name === t || f.name.toLowerCase() === t.toLowerCase(),
  );
}

export interface SteeringController {
  /** the discovered candidate files (loaded + missing) for `/memory` + the badge. */
  list: () => SteeringFile[];
  /** the assembled steering system block for the turnCtx getter (null when none loaded). */
  block: () => string | null;
  /** re-discover + re-assemble (called after an edit/create); returns a status line. */
  reload: () => string;
  /** open $EDITOR on `n|path`, then reload; returns a status line. */
  edit: (target: string) => Promise<string>;
  /** scaffold a project AGENTS.md (confirm), then reload; returns a status line. */
  create: () => Promise<string>;
}

export interface SteeringDeps {
  /** the live cwd (a getter — the session cwd can change). */
  cwd: () => string;
  home?: string;
  read?: ReadSeam;
  /** write a file (fs seam); the create path routes through here. */
  write: (path: string, content: string) => void;
  /** spawn $EDITOR on a file with an inherited TTY (default = CLI-044's defaultOpenEditor). */
  openEditor: (file: string) => number;
  /** y/N confirm for create (never-force). */
  confirm: (prompt: string) => Promise<boolean>;
}

/**
 * Build the stateful `/memory` controller both the readline host and the raw-TUI bridge share.
 * Holds the discovered files; `block()` re-reads on every call so an `edit`→reload feeds the NEXT
 * turn's system prompt (CLI-061). All IO (fs read/write, editor spawn) is an injected seam.
 */
export function createSteeringController(deps: SteeringDeps): SteeringController {
  let files = discoverSteering(deps.cwd(), deps.home, deps.read);
  const rediscover = (): void => {
    files = discoverSteering(deps.cwd(), deps.home, deps.read);
  };
  return {
    list: () => files,
    block: () => assembleSteering(files) || null,
    reload: () => {
      rediscover();
      const badge = steeringBadge(files);
      return badge ? `steering reloaded — ${badge}` : "steering reloaded — no files loaded";
    },
    edit: async (target) => {
      const file = resolveSteeringTarget(files, target);
      if (!file) return `no steering file matches "${target}" (use /memory to list)`;
      if (file.path.startsWith("-")) return "refusing option-shaped path";
      deps.openEditor(file.path);
      rediscover();
      return `edited ${file.name} — ${steeringBadge(files) || "no files loaded"}`;
    },
    create: async () => {
      const path = join(deps.cwd(), "AGENTS.md");
      const existing = files.find((f) => f.path === path && f.loaded);
      if (existing) return `${path} already exists — /memory edit it instead`;
      if (!(await deps.confirm(`create project steering ${path}?`))) return "(not created)";
      deps.write(path, rules.initRulesScaffold({ projectName: basename(deps.cwd()) || "project" }));
      rediscover();
      return `created ${path} — ${steeringBadge(files) || "loaded"}`;
    },
  };
}
