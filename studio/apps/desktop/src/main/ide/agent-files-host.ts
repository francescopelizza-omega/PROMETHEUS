/**
 * main/ide/agent-files-host.ts — discover `*.md` sub-agent personas on disk (Task #5, desktop
 * parity).
 *
 * The fs half of `@prometheus/core/agent-files`'s `loadAgentFile` (core stays pure) — this is
 * the SAME split apps/cli/src/session/agent-file-store.ts already made, ported here so
 * desktop's `spawn_agent` gets the exact same persona support over IPC (the renderer is
 * sandboxed and cannot touch node:fs, C5). Two directories, and the distinction between them is
 * the security model, not a convenience:
 *
 *   ~/.prometheus/agents/*.md         USER scope — the human's own files, honoured.
 *   <repo>/.prometheus/agents/*.md    PROJECT scope — arrives with cloned code, clamped hard.
 *
 * `loadAgentFile` does the clamping (model refused, read-only forced, tools only narrow, body
 * capped/fenced); this module only decides which scope a path belongs to, and never lets a
 * project file win a name — same as the CLI's twin.
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

/**
 * Every persona available for `root`, USER scope first. A user file WINS a name collision —
 * the project layer may add personas; it may not replace one the human wrote.
 */
export function loadAgentFiles(root: string, home: string = prometheusHome()): LoadedAgent[] {
  const user = loadDir(join(home, "agents"), "user");
  const projectDir = discoverProjectAgentsDir(root, home);
  const project = projectDir ? loadDir(projectDir, "project") : [];
  const taken = new Set(user.map((a) => a.name));
  return [...user, ...project.filter((a) => !taken.has(a.name))];
}
