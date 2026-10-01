// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/gate.ts — decide what a user-defined slash command is ALLOWED to do.
 *
 * `loader.ts` is a complete parser that deliberately resolves nothing: it hands back the
 * `@filepath` refs and the ``!`cmd` `` injections it found and calls that boundary a gate. This
 * module is that gate. It is pure policy — it resolves nothing either, it decides.
 *
 * WHY THE POLICY IS ABOUT PROVENANCE, NOT CONTENT. A command file is markdown that can embed a
 * shell command and file reads, and it is discovered on disk. Two very different files reach
 * the same parser:
 *
 *   USER scope    ~/.prometheus/command/*.md — the human wrote it, for themselves.
 *   PROJECT scope <repo>/.prometheus/command/*.md — it arrived with cloned code.
 *
 * The project case is the third instance of a shape already fixed twice here (`.prometheus.toml`
 * disabling the scanner; `<repo>/.prometheus/settings.json` undoing a security profile). And a
 * stored command string is strictly worse than those: `gateMode` at least had a safe direction
 * to clamp toward, whereas "run this string" has none. So the rule follows the precedent the
 * repo already set for `engine.paths` — the project layer does not get the key at all.
 *
 * A NOTE ON WHO TYPED IT. A slash command runs because a human typed `/name`, not because a
 * model chose it, and that is a real difference — but it is not the relevant one. The human
 * typed a NAME; they did not read the markdown behind it, and in a cloned repo they have never
 * seen it. Consent to run "/deploy" is not consent to run whatever `deploy.md` contains.
 *
 * PURE: no fs, no spawn, no fetch.
 */

import { isRemoteRef } from "./loader.js";

/** Where a command file came from — the only input that decides what it may do. */
export type CommandScope = "user" | "project";

/** One thing a command file asked for and did not get. */
export interface CommandRejection {
  what: string;
  reason: string;
}

/** What a command file is permitted to do, after the gate. */
export interface CommandPlan {
  /** file refs that may be read, already validated as workspace-relative and non-remote. */
  reads: string[];
  /** shell commands that may run — ALWAYS still gated and confirmed by the caller. */
  runs: string[];
  /** everything refused, for the caller to show the human. */
  rejected: CommandRejection[];
}

/** Reject a ref that could escape the workspace, name a flag, or reach the network. */
function refRejection(ref: string): string | null {
  if (isRemoteRef(ref)) return "remote references are never fetched";
  if (ref.startsWith("-")) return "option-shaped reference";
  if (ref.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ref)) return "absolute paths are not allowed";
  /**
   * `~` is an absolute path wearing a disguise.
   *
   * The list above rejected `/abs`, `C:\abs` and any `..` segment, but not a leading `~/` — and
   * `read_file` expands `~` for real. So a cloned repo shipping
   * `.prometheus/command/summarize.md` containing `Summarize @~/Documents/notes.md` read a file
   * from the user's home directory and spliced it into the prompt, on `/summarize`.
   *
   * This gate is the only bound on that path: `expandCommand` calls `runSystemTool("read_file")`
   * DIRECTLY, and the read tool does not consult the working-set roots — the fail-closed scope
   * check lives in the agent-runtime dispatcher, which this path never goes through. The
   * function's own docstring justified permitting project-scope refs on the grounds that "a read
   * is bounded by the working set the caller already enforces for read_file"; no caller enforced
   * it, which is what made this reachable.
   */
  if (ref === "~" || ref.startsWith("~/") || ref.startsWith("~\\")) {
    return "`~` home paths are not allowed";
  }
  if (ref.split(/[\\/]/).includes("..")) return "`..` cannot escape the workspace";
  if (ref.includes("\0")) return "embedded NUL";
  return null;
}

/**
 * Strip trailing punctuation the ref regex swallows.
 *
 * `FILE_REF_RE` has no word boundary, so `@src/a.ts.` and `@src/a.ts,` capture the trailing
 * character. Trimming here rather than widening the regex keeps one detector — a second regex
 * would be a second thing to keep in agreement with the first.
 */
function tidyRef(ref: string): string {
  return ref.replace(/[.,;:)\]}'"]+$/, "");
}

/**
 * Apply the gate to one parsed command file.
 *
 * File refs are permitted in BOTH scopes (a read is bounded by the working set the caller
 * already enforces for `read_file`) once they are shown to be workspace-relative and local.
 * Shell injections are permitted in USER scope ONLY, and even then they are only *eligible* —
 * the caller still runs them through the nemesis gate and still asks the human, because a
 * string stored in a file six months ago has not earned the autonomy ladder's auto-approval.
 */
export function gateCommandFile(
  file: { fileRefs: readonly string[]; shellInjections: readonly string[] },
  scope: CommandScope,
): CommandPlan {
  const rejected: CommandRejection[] = [];
  const reads: string[] = [];
  for (const raw of file.fileRefs) {
    const ref = tidyRef(raw);
    if (!ref) continue;
    const why = refRejection(ref);
    if (why) rejected.push({ what: `@${raw}`, reason: why });
    else reads.push(ref);
  }

  const runs: string[] = [];
  for (const cmd of file.shellInjections) {
    if (scope === "project") {
      rejected.push({
        what: `!\`${cmd}\``,
        reason:
          "a command file from this repository cannot run a shell command — move it to your " +
          "own ~/.prometheus/command/ if you wrote it and want it to run",
      });
      continue;
    }
    runs.push(cmd);
  }
  return { reads, runs, rejected };
}

/**
 * The placeholder a refused injection leaves in the prompt.
 *
 * Refusals are VISIBLE rather than silently dropped, for the same reason the project-profile
 * refusals print: the person who wrote the line expects it to work, and a model handed a
 * silently-emptied template will confidently reason from a gap it cannot see.
 */
export function refusalMarker(what: string): string {
  return `[refused: ${what} — not run]`;
}

/**
 * Whether a command name may be used at all.
 *
 * The name comes from a FILENAME, so `-rf.md`, `..md` and unicode lookalikes are all reachable.
 * Built-ins are also protected here: a repo that ships `gate.md` must not be able to change what
 * `/gate` means, and the check has to live somewhere both the loader and the dispatcher agree on.
 */
export function isUsableCommandName(name: string, builtins: ReadonlySet<string>): boolean {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) return false;
  return !builtins.has(name);
}
