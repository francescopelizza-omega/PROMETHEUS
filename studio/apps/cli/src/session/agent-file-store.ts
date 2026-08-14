/**
 * session/agent-file-store.ts — discover `*.md` sub-agent personas on disk.
 *
 * The fs half of `@prometheus/core`'s `agent-files` (core stays pure). Two directories, and the
 * distinction between them is the security model, not a convenience:
 *
 *   ~/.prometheus/agents/*.md         USER scope — the human's own files, honoured.
 *   <repo>/.prometheus/agents/*.md    PROJECT scope — arrives with cloned code, clamped hard.
 *
 * The project directory is found by walking UP from the working directory, exactly as
 * `.prometheus.toml` is, which is precisely why it cannot be trusted: `cd` into a repository is
 * the whole of the attack. `loadAgentFile` does the clamping; this file only decides which
 * scope a path belongs to, and never lets a project file win a name.
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

/**
 * Every persona available to this session, USER scope first.
 *
 * A user file WINS a name collision. The project layer may add personas; it may not replace one
 * the human wrote, which would be the quietest possible way to change what a name means.
 */
export function loadAgentFiles(cwd: string, home = prometheusHome()): LoadedAgent[] {
  const user = loadDir(join(home, "agents"), "user");
  const projectDir = discoverProjectAgentsDir(cwd, home);
  const project = projectDir ? loadDir(projectDir, "project") : [];
  const taken = new Set(user.map((a) => a.name));
  return [...user, ...project.filter((a) => !taken.has(a.name))];
}
