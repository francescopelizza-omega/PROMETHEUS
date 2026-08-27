/**
 * commands/meet-cmd.ts — `prometheus meet`: "meet your codebase" (roadmap point 6).
 *
 * A friendly, human-facing read of a repo a user just opened — what stack it looks like, where
 * the code actually lives, what it's mostly written in, a taste of what it defines, and where to
 * start reading. This is NOT a new analysis engine: it is `@prometheus/core`'s already-built,
 * already-tested `token-economy/repo-map.ts` walker (the SAME one CLI-053's `/repomap` uses to
 * silently ground the agent's context) read through `token-economy/codebase-overview.ts`'s
 * `summarizeCodebase`/`renderCodebaseOverview` — a different reader over the same walk, not a
 * second walker. Stack detection is root-level MARKER FILES only (package.json, Cargo.toml, …),
 * never a parse of file contents, so it stays honest about being a heuristic first impression,
 * not a verdict.
 *
 * On-demand, not an auto-popping wizard: it runs when the user asks (`prometheus meet`, or a
 * button click on the desktop), not silently the first time a folder is opened. An unannounced
 * scan on every new workspace risks surprising a user with a full-repo read they did not ask for
 * — the CLI's own `/repomap` already defaults OFF for exactly this reason ("the first turn in a
 * huge repo never pays an unexpected full walk").
 */
import { readFileSync, readdirSync, statSync } from "node:fs";

import { tokenEconomy } from "@prometheus/core";

import type { CliContext, CommandOutcome } from "../context.js";

/** The real filesystem adapter — the ONLY node:fs binding this command needs (core stays IO-free,
 *  mirrors session/repo-map-state.ts's own `nodeRepoFs`, kept local since this command's walk is
 *  a one-shot read, not a session-scoped toggle needing to share that state). */
function nodeRepoFs(): tokenEconomy.RepoFs {
  return {
    readdir: (dir) =>
      readdirSync(dir || ".", { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isSymlink: d.isSymbolicLink(),
      })),
    readFile: (p) => readFileSync(p, "utf8"),
    statSize: (p) => statSync(p).size,
  };
}

export function runMeetCommand(cwd: string): CommandOutcome {
  // walkRepo itself is deliberately fail-SOFT on an unreadable root (built for grounding an
  // agent's context, where a bad path must never abort a turn) — an unreadable/nonexistent dir
  // would otherwise report a confusing "0 files", indistinguishable from a genuinely empty one.
  // This command is a one-shot, explicitly user-invoked read of a NAMED directory, so it checks
  // existence itself first and reports the real reason honestly.
  try {
    if (!statSync(cwd).isDirectory()) {
      return {
        text: `error: "${cwd}" is not a directory`,
        json: { ok: false, error: "not a directory" },
        exitCode: 1,
      };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      text: `error: could not read "${cwd}": ${message}`,
      json: { ok: false, error: message },
      exitCode: 1,
    };
  }

  let map: tokenEconomy.RepoMap;
  try {
    map = tokenEconomy.walkRepo(nodeRepoFs(), cwd);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      text: `error: could not read this directory: ${message}`,
      json: { ok: false, error: message },
      exitCode: 1,
    };
  }
  const overview = tokenEconomy.summarizeCodebase(map);
  return {
    text: tokenEconomy.renderCodebaseOverview(overview),
    json: { ok: true, ...overview },
    exitCode: 0,
  };
}

/** The `prometheus meet` dispatcher entry point (index.ts's one-line registration). */
export function runMeetCommandFromCtx(ctx: CliContext): CommandOutcome {
  return runMeetCommand(ctx.args.cwd ?? process.cwd());
}
