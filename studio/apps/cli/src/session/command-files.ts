// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/command-files.ts — user-defined slash commands from markdown.
 *
 * The fs + execution half of core's pure `commandLoader` (parse) and `commandGate` (policy).
 * A command file turns `/review` into a prompt template with arguments, file reads and — from
 * the user's own directory only — shell output.
 *
 *   ~/.prometheus/command/*.md        USER scope. `!`cmd`` may run (gated + confirmed).
 *   <repo>/.prometheus/command/*.md   PROJECT scope. Reads only; shell is refused, visibly.
 *
 * ORDER OF OPERATIONS IS LOAD-BEARING. Detection happens on the file's ORIGINAL body — which is
 * what `parseCommandFile` already did — and argument substitution happens AFTERWARDS, into the
 * already-resolved text. Doing it the other way round would let a user's own typed argument
 * become an injection: `/review "!\`rm -rf ~\`"` would be substituted into the template and then
 * detected as a command to run. The two orders are not equivalent and only one is safe.
 *
 * A built-in always wins a name, and a user file always beats a project file — a repo cannot
 * quietly change what `/gate` or `/review` means.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { commandGate, commandLoader } from "@prometheus/core";

import { prometheusHome } from "../home.js";

type CommandFile = commandLoader.CommandFile;
type CommandScope = commandGate.CommandScope;

/** One discovered command, with the provenance that decides what it may do. */
export interface LoadedCommand {
  file: CommandFile;
  scope: CommandScope;
  /** absolute path, for the "where did this come from" line. */
  path: string;
}

const COMMAND_SUBDIR = join(".prometheus", "command");

function loadDir(dir: string, scope: CommandScope, builtins: ReadonlySet<string>): LoadedCommand[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LoadedCommand[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      const parsed = commandLoader.parseCommandFile(name, readFileSync(join(dir, name), "utf8"));
      if (!parsed.ok) continue;
      // A built-in name is refused HERE, before the command can exist at all — the dispatcher
      // consulting built-ins first would already be safe, but a shadowing file that silently
      // never runs is its own kind of confusing.
      if (!commandGate.isUsableCommandName(parsed.file.name, builtins)) continue;
      out.push({ file: parsed.file, scope, path: join(dir, name) });
    } catch {
      /* one unreadable command is skipped; the rest still load */
    }
  }
  return out;
}

/** The nearest `<dir>/.prometheus/command` walking up from `cwd`. */
export function discoverProjectCommandDir(
  cwd: string,
  home = prometheusHome(),
): string | undefined {
  if (process.env.PROM_NO_PROJECT_CONFIG === "1") return undefined;
  let dir = resolve(cwd);
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

/** Every user-defined command available here. USER scope wins a name collision. */
export function loadCommandFiles(
  cwd: string,
  builtins: ReadonlySet<string>,
  home = prometheusHome(),
): LoadedCommand[] {
  const user = loadDir(join(home, "command"), "user", builtins);
  const dir = discoverProjectCommandDir(cwd, home);
  const project = dir ? loadDir(dir, "project", builtins) : [];
  const taken = new Set(user.map((c) => c.file.name));
  return [...user, ...project.filter((c) => !taken.has(c.file.name))];
}

/** The seams the expansion needs — all injected, so the whole thing is testable without IO. */
export interface ExpandDeps {
  /** read a workspace file (already working-set + secret guarded by the caller). */
  readFile: (relPath: string) => Promise<string>;
  /** run a shell command through the nemesis gate + human confirm; null ⇒ refused. */
  runShell: (command: string) => Promise<string | null>;
  /** how much of one substitution may land in the prompt. */
  maxPartChars?: number;
}

export interface ExpandedCommand {
  prompt: string;
  rejected: commandGate.CommandRejection[];
}

/** Cap one interpolated part so a huge file or a chatty command cannot fill the window. */
const DEFAULT_MAX_PART = 8000;

/**
 * Expand a command file into the prompt the agent receives.
 *
 * Resolution happens against the ORIGINAL template and argument substitution happens last —
 * see the header. Every refusal leaves a visible marker rather than a gap.
 */
export async function expandCommand(
  cmd: LoadedCommand,
  args: readonly string[],
  deps: ExpandDeps,
): Promise<ExpandedCommand> {
  const cap = deps.maxPartChars ?? DEFAULT_MAX_PART;
  const plan = commandGate.gateCommandFile(cmd.file, cmd.scope);
  const rejected = [...plan.rejected];
  let text = cmd.file.template;

  const clip = (s: string): string =>
    s.length > cap ? `${s.slice(0, cap)}\n…[truncated at ${cap} chars]` : s;

  // `@file` → its contents.
  for (const ref of plan.reads) {
    try {
      const body = await deps.readFile(ref);
      text = text.split(`@${ref}`).join(`\n--- ${ref} ---\n${clip(body)}\n--- end ${ref} ---\n`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      rejected.push({ what: `@${ref}`, reason });
      text = text.split(`@${ref}`).join(commandGate.refusalMarker(`@${ref}`));
    }
  }
  // Refused reads still need their marker, or the model reasons from a silent gap.
  for (const r of plan.rejected) {
    if (r.what.startsWith("@")) text = text.split(r.what).join(commandGate.refusalMarker(r.what));
  }

  // ``!`cmd` `` → its output, or a marker.
  for (const command of plan.runs) {
    const token = `!\`${command}\``;
    const out = await deps.runShell(command);
    text =
      out === null
        ? text.split(token).join(commandGate.refusalMarker(token))
        : text.split(token).join(`\n--- $ ${command} ---\n${clip(out)}\n--- end ---\n`);
    if (out === null) rejected.push({ what: token, reason: "declined or blocked by the gate" });
  }
  for (const r of plan.rejected) {
    if (r.what.startsWith("!")) text = text.split(r.what).join(commandGate.refusalMarker(r.what));
  }

  // Arguments LAST, into already-resolved text — a user-typed argument can no longer become an
  // injection because nothing scans the result.
  return { prompt: commandLoader.substituteArgs(text, args), rejected };
}
