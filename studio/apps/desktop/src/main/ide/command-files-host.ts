/**
 * main/ide/command-files-host.ts — user-defined slash commands from markdown (Task #5,
 * desktop parity with the CLI's `command-files.ts`).
 *
 * The fs half of core's pure `commandLoader` (parse) and `commandGate` (policy) — the SAME
 * split apps/cli/src/session/command-files.ts already made, ported here so desktop's chat
 * surface gets the same custom-command support (the renderer is sandboxed and cannot touch
 * node:fs, C5):
 *
 *   ~/.prometheus/command/*.md        USER scope. `!`cmd`` may run (gated + confirmed).
 *   <repo>/.prometheus/command/*.md   PROJECT scope. Reads only; shell is refused, visibly.
 *
 * A user file always beats a project file — a repo cannot quietly change what `/review` means.
 * Desktop has no CLI-style single-word built-in slash names of its own (its command-palette ids
 * are dot-namespaced, e.g. `git.commit`), so the reserved-name set passed to
 * `commandGate.isUsableCommandName` is empty — nothing here collides with a filename-derived
 * `/name`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { commandGate, commandLoader } from "@prometheus/core";
import { prometheusHome } from "@prometheus/core/agent-system-host";

type CommandFile = commandLoader.CommandFile;
type CommandScope = commandGate.CommandScope;

/** One discovered command, with the provenance that decides what it may do. */
export interface LoadedCommandFile {
  file: CommandFile;
  scope: CommandScope;
  /** absolute path, for the "where did this come from" line. */
  path: string;
}

const COMMAND_SUBDIR = join(".prometheus", "command");

/** No CLI-style single-word built-ins exist in desktop's custom-command namespace today. */
const NO_BUILTINS: ReadonlySet<string> = new Set();

function loadDir(dir: string, scope: CommandScope): LoadedCommandFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LoadedCommandFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      const parsed = commandLoader.parseCommandFile(name, readFileSync(join(dir, name), "utf8"));
      if (!parsed.ok) continue;
      if (!commandGate.isUsableCommandName(parsed.file.name, NO_BUILTINS)) continue;
      out.push({ file: parsed.file, scope, path: join(dir, name) });
    } catch {
      /* one unreadable command is skipped; the rest still load */
    }
  }
  return out;
}

/** The nearest `<dir>/.prometheus/command` walking up from `root`. */
export function discoverProjectCommandDir(
  root: string,
  home: string = prometheusHome(),
): string | undefined {
  let dir = resolve(root);
  for (;;) {
    if (dir === home) break;
    const candidate = join(dir, COMMAND_SUBDIR);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Every user-defined command available for `root`. USER scope wins a name collision. */
export function loadCommandFiles(
  root: string,
  home: string = prometheusHome(),
): LoadedCommandFile[] {
  const user = loadDir(join(home, "command"), "user");
  const dir = discoverProjectCommandDir(root, home);
  const project = dir ? loadDir(dir, "project") : [];
  const taken = new Set(user.map((c) => c.file.name));
  return [...user, ...project.filter((c) => !taken.has(c.file.name))];
}
