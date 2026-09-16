/**
 * session/effort-rules.ts — the disk half of the effort capability table.
 *
 * `ai/effort/rules.ts` has opened with "adding the 40th model should be a data edit, not a code
 * change" since it was written, and `resolveCapability(ctx, rules)` has accepted an injected
 * table since then too — but every caller in the repo used the default, so the seam was
 * unreachable and a model released next week meant editing TypeScript and shipping a build.
 *
 * This is the loader that finally reaches it. Two layers, both optional, both plain JSON:
 *
 *   ~/.prometheus/effort-capabilities.json      the user's machine
 *   <project>/.prometheus/effort-capabilities.json   checked in with the repo
 *
 * Precedence is APPEND ORDER, because `resolveCapability` scores specificity and breaks a tie in
 * favour of the LATER rule — so builtins, then user, then workspace, and "later wins" is the
 * whole rule. See `ai/effort/rule-store.ts` for why the builtins stay in code rather than moving
 * into the file wholesale.
 *
 * FAIL-SOFT and LOUD: an unreadable or malformed file leaves the builtins standing, and the
 * reason comes back to the caller to print. A rule the user believes is in force but which was
 * silently dropped is worse than no override at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ai } from "@prometheus/core";
import { prometheusHome } from "@prometheus/core/agent-system-host";

/** Where a layer's file lives, relative to the layer's root. */
const RULES_SUBPATH = join(".prometheus", ai.EFFORT_RULES_FILENAME);

export interface EffortRulesLoad {
  /** builtins + every override layer, in precedence order. Never empty. */
  rules: ai.EffortRule[];
  /** one line per problem, ready to print. Empty on the happy path (including "no file"). */
  notes: string[];
  /** the files that actually contributed, for `/status` and for tests. */
  sources: string[];
}

/** Read + parse ONE layer. A missing file is not a problem and produces no note. */
function layer(path: string): { rules: ai.EffortRule[]; notes: string[]; used: boolean } {
  if (!existsSync(path)) return { rules: [], notes: [], used: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { rules: [], notes: [`${path}: not valid JSON — ${why}`], used: false };
  }
  const parsed = ai.parseEffortRules(raw);
  return {
    rules: parsed.rules,
    notes: parsed.errors.map((err) => `${path}: ${err}`),
    used: parsed.rules.length > 0,
  };
}

/**
 * Walk up from `cwd` for a project `.prometheus/` directory, stopping at the home directory.
 *
 * Mirrors `discoverProjectToml`'s bounds deliberately: a rules file above `~` would apply to
 * every project on the machine while looking like it belonged to one of them, and the same
 * `PROM_NO_PROJECT_CONFIG` escape hatch turns the whole project layer off.
 */
function discoverProjectRules(cwd: string): string | undefined {
  if (process.env.PROM_NO_PROJECT_CONFIG === "1") return undefined;
  const stop = homedir();
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, RULES_SUBPATH);
    if (existsSync(candidate)) return candidate;
    if (dir === stop) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * The effective rule table for this session.
 *
 * `home` is injectable so a test can point at a fixture directory instead of the real
 * `~/.prometheus`, exactly as the rest of the session's stores do.
 */
export function loadEffortRules(cwd: string, home?: string): EffortRulesLoad {
  const notes: string[] = [];
  const sources: string[] = [];

  // `prometheusHome()`, not a hand-spelled `~/.prometheus`: the hard-coded twin ignored
  // $PROMETHEUS_HOME, so the one variable that sandboxes the product moved every other root and
  // left this one reading the real machine's rules file.
  const userPath = join(home ?? prometheusHome(), ai.EFFORT_RULES_FILENAME);
  const user = layer(userPath);
  notes.push(...user.notes);
  if (user.used) sources.push(userPath);

  const projectPath = discoverProjectRules(cwd);
  const project = projectPath ? layer(projectPath) : { rules: [], notes: [], used: false };
  notes.push(...project.notes);
  if (project.used && projectPath) sources.push(projectPath);

  // Builtins first, then user, then project — the LAST matching rule of equal specificity wins.
  return { rules: ai.layerEffortRules(user.rules, project.rules), notes, sources };
}
