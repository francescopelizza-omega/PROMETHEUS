// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/agent-file-store.ts — discover `*.md` sub-agent personas on disk.
 *
 * The fs half of `@prometheus/core`'s `agent-files` (core stays pure). Three directories, and
 * the distinction between them is the security model, not a convenience:
 *
 *   ~/.prometheus/agents/*.md           USER scope — the human's own files, honoured.
 *   <repo>/.prometheus/agents/*.md      PROJECT scope — arrives with cloned code, clamped hard.
 *   ~/.prometheus/agents/imported/*.md  IMPORTED scope — arrived from ANOTHER USER via persona
 *     sharing (`session/persona-store.ts`'s import), clamped IDENTICALLY to PROJECT. It lives
 *     under the user's OWN home (not a project) because sharing is a personal action — you
 *     import a persona once and expect it everywhere, the way your own personas already work —
 *     but it is physically SEPARATE from `agents/*.md` so it is never mistaken for (or loaded
 *     as) the human's own, fully-trusted work. `readdirSync(join(home,"agents"))` already skips
 *     this subdirectory on its own (the loop below only reads `*.md` files, never recurses), so
 *     introducing it here changes nothing about how the existing USER-scope directory is read.
 *
 * The project directory is found by walking UP from the working directory, exactly as
 * `.prometheus.toml` is, which is precisely why it cannot be trusted: `cd` into a repository is
 * the whole of the attack. `loadAgentFile` does the clamping; this file only decides which
 * scope a path belongs to, and never lets a project OR imported file win a name over the user's
 * own.
 *
 * Fail-soft throughout: an unreadable directory means no personas, never a broken session.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { agent } from "@prometheus/core";

import { prometheusHome } from "../home.js";

type LoadedAgent = agent.LoadedAgent;

/** The per-scope directory names. */
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

/**
 * The nearest `<dir>/.prometheus/agents` walking up from `cwd`, or undefined.
 *
 * Stops at the filesystem root AND at the user's home: a persona directory in `$HOME` would be
 * discovered for every project on the machine while being labelled "project", which is the
 * worst of both scopes. `PROM_NO_PROJECT_CONFIG=1` short-circuits it entirely, matching the
 * profile loader's escape hatch.
 */
export function discoverProjectAgentsDir(cwd: string, home = prometheusHome()): string | undefined {
  if (process.env.PROM_NO_PROJECT_CONFIG === "1") return undefined;
  let dir = resolve(cwd);
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
export function loadImportedAgentFiles(home = prometheusHome()): LoadedAgent[] {
  return loadDir(join(home, "agents", "imported"), "imported");
}

/**
 * Every persona available to this session, USER scope first, then PROJECT, then IMPORTED.
 *
 * A user file WINS every name collision. Project and imported may each add personas but never
 * replace one an earlier, higher-priority layer already defined — the quietest possible way to
 * change what a name means — so a name is claimed by exactly one layer, in this fixed order.
 */
export function loadAgentFiles(cwd: string, home = prometheusHome()): LoadedAgent[] {
  const user = loadDir(join(home, "agents"), "user");
  const projectDir = discoverProjectAgentsDir(cwd, home);
  const project = projectDir ? loadDir(projectDir, "project") : [];
  const imported = loadImportedAgentFiles(home);

  const taken = new Set(user.map((a) => a.name));
  const keptProject = project.filter((a) => !taken.has(a.name));
  for (const a of keptProject) taken.add(a.name);
  const keptImported = imported.filter((a) => !taken.has(a.name));

  return [...user, ...keptProject, ...keptImported];
}
