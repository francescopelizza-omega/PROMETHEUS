// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/agent-files-host.ts — discover `*.md` sub-agent personas on disk (Task #5, desktop
 * parity).
 *
 * The fs half of `@prometheus/core/agent-files`'s `loadAgentFile` (core stays pure) — this is
 * the SAME split apps/cli/src/session/agent-file-store.ts already made, ported here so
 * desktop's `spawn_agent` gets the exact same persona support over IPC (the renderer is
 * sandboxed and cannot touch node:fs, C5). Three directories, and the distinction between them
 * is the security model, not a convenience:
 *
 *   ~/.prometheus/agents/*.md           USER scope — the human's own files, honoured.
 *   <repo>/.prometheus/agents/*.md      PROJECT scope — arrives with cloned code, clamped hard.
 *   ~/.prometheus/agents/imported/*.md  IMPORTED scope — arrived from another user via persona
 *     sharing (main/persona-ipc.ts's import), clamped IDENTICALLY to PROJECT — same reasoning
 *     as the CLI's twin (session/agent-file-store.ts).
 *
 * `loadAgentFile` does the clamping (model refused, read-only forced, tools only narrow, body
 * capped/fenced); this module only decides which scope a path belongs to, and never lets a
 * project or imported file win a name — same as the CLI's twin.
 *
 * Fail-soft throughout: an unreadable directory means no personas, never a broken session.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { agent } from "@prometheus/core";
import { prometheusHome } from "@prometheus/core/agent-system-host";

type LoadedAgent = agent.LoadedAgent;

const AGENTS_SUBDIR = join(".prometheus", "agents");

/** Read every `*.md` in a directory as a persona at `scope`. Missing dir ⇒ none. */
function loadDir(dir: string, scope: agent.AgentFileScope): LoadedAgent[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LoadedAgent[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      const text = readFileSync(join(dir, name), "utf8");
      const loaded = agent.loadAgentFile(basename(name, ".md"), text, scope);
      if (loaded) out.push(loaded);
    } catch {
      /* one unreadable persona is skipped; the rest still load */
    }
  }
  return out;
}

/** The nearest `<dir>/.prometheus/agents` walking up from `root`, or undefined. Stops at the
 *  filesystem root AND at the user's home (a persona dir in $HOME would otherwise be
 *  "discovered" for every project on the machine while being labelled "project"). */
export function discoverProjectAgentsDir(
  root: string,
  home: string = prometheusHome(),
): string | undefined {
  let dir = resolve(root);
  for (;;) {
    if (dir === home) break;
    const candidate = join(dir, AGENTS_SUBDIR);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** `~/.prometheus/agents/imported/*.md` — personas imported from another user via sharing.
 *  Always IMPORTED scope, regardless of what any individual file's frontmatter claims. */
export function loadImportedAgentFiles(home: string = prometheusHome()): LoadedAgent[] {
  return loadDir(join(home, "agents", "imported"), "imported");
}

/**
 * Every persona available for `root`, USER scope first, then PROJECT, then IMPORTED. A user
 * file WINS every name collision; project and imported each add personas but never replace one
 * an earlier, higher-priority layer already defined.
 */
export function loadAgentFiles(root: string, home: string = prometheusHome()): LoadedAgent[] {
  const user = loadDir(join(home, "agents"), "user");
  const projectDir = discoverProjectAgentsDir(root, home);
  const project = projectDir ? loadDir(projectDir, "project") : [];
  const imported = loadImportedAgentFiles(home);

  const taken = new Set(user.map((a) => a.name));
  const keptProject = project.filter((a) => !taken.has(a.name));
  for (const a of keptProject) taken.add(a.name);
  const keptImported = imported.filter((a) => !taken.has(a.name));

  return [...user, ...keptProject, ...keptImported];
}
