/**
 * steering-load.ts — which steering files the desktop agent pane loads, and from where.
 *
 * Extracted from AgentPane's effect so the rule is testable: `.tsx` cannot be loaded by
 * node:test, and this pane had drifted away from the CLI unnoticed for exactly that reason. It
 * read only the workspace root's `AGENTS.md` and `CLAUDE.md`, so `PROMETHEUS.md` — the file the
 * CLI's own /memory prompt tells the model to write to — was ignored, and the entire `global`
 * half of core's `DEFAULT_PRECEDENCE` (`~/.prometheus/AGENTS.md`, `~/.prometheus/CLAUDE.md`) was
 * dead on this host: a user's standing personal instructions were in force in the CLI and
 * silently absent in the app.
 *
 * The IO is a seam. The project files come from `fsRead` (the renderer knows the workspace
 * root); the global pair comes from main, which owns the home path — the renderer has no `~` to
 * expand and teaching the path-guarded `fsRead` to expand one would widen that guard for every
 * caller.
 */
import * as rules from "@prometheus/core/rules";

/** The two reads this module needs, so a test can supply them without electron. */
export interface SteeringIo {
  /** read a PROJECT file by base name, relative to the workspace root. */
  readProjectFile(name: string): Promise<string | undefined>;
  /** the loaded `~/.prometheus` pair, already filtered by main. */
  readGlobal(): Promise<{ kind: rules.RuleKind; path: string; content: string }[]>;
}

/**
 * Collect the steering sources for one workspace, in `DEFAULT_PRECEDENCE`-consistent order.
 *
 * A file whose content is (or starts with) a remote URL is a fetch directive, not guidance, and
 * is dropped rather than folded into the prompt unfetched-and-unverified — the same
 * URL-injection posture the CLI's steering loader takes. (Main applies the identical filter to
 * the global pair before it crosses IPC; re-checking here costs nothing and keeps this function
 * correct for any caller.)
 */
export async function loadSteeringSources(io: SteeringIo): Promise<rules.RuleSource[]> {
  const sources: rules.RuleSource[] = [];
  for (const name of rules.STEERING_PROJECT_NAMES) {
    const text = await io.readProjectFile(name).catch(() => undefined);
    if (typeof text !== "string" || !text.trim() || rules.isRemoteInstruction(text)) continue;
    sources.push({
      scope: "project",
      kind: rules.steeringKindOf(name),
      path: name,
      content: text,
    });
  }
  const global = await io.readGlobal().catch(() => []);
  for (const g of global) {
    if (!g.content.trim() || rules.isRemoteInstruction(g.content)) continue;
    sources.push({ scope: "global", kind: g.kind, path: g.path, content: g.content });
  }
  return sources;
}
