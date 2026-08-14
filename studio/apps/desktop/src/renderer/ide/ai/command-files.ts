/**
 * ai/command-files.ts — user-defined slash commands from markdown, in the AgentPane composer
 * (Task #5, desktop parity with apps/cli/src/session/command-files.ts).
 *
 * The discovery half (walking `~/.prometheus/command` + `<repo>/.prometheus/command`) is
 * main-only (node:fs, C5) — see main/ide/command-files-host.ts, reached over
 * `window.prometheus.ide.commandFilesList`. This module is the renderer's half: matching a
 * typed `/name args…` composer line against the loaded list, and EXPANDING it into the prompt
 * the agent receives — reusing core's pure `commandGate` (policy) and `commandLoader`
 * (substitution) directly, not a reimplementation of either.
 *
 * ORDER OF OPERATIONS IS LOAD-BEARING, exactly as in the CLI: `gateCommandFile` runs against
 * the file's ORIGINAL template, and argument substitution happens LAST, into the already-
 * resolved text — never the other way round, or a user's own typed argument could be
 * substituted into the template and then detected as a command to run.
 *
 * KNOWN LIMITATION (honest, not silent): a USER-scope command's ``!`cmd` `` shell injection is
 * policy-ALLOWED by `commandGate` (same as the CLI), but desktop has no pre-send confirm dialog
 * yet to gate it interactively the way the CLI's `ctx.ask` does — so `deps.runShell` here always
 * refuses, for EVERY scope, until that confirm UI exists. The refusal is reported through the
 * SAME `refusalMarker` mechanism as a real gate refusal, never a silent drop.
 */
import {
  type CommandRejection,
  type CommandScope,
  gateCommandFile,
  refusalMarker,
} from "@prometheus/core/command-gate";
import { type CommandFile, substituteArgs } from "@prometheus/core/command-loader";

import type { IdeLoadedCommandFile } from "../../../shared/ipc-contract.js";

/** Cap one interpolated part so a huge file or a chatty command cannot fill the window. */
const DEFAULT_MAX_PART = 8000;

export interface ExpandCommandFileDeps {
  /** read a workspace file (already working-set + secret guarded by the caller). */
  readFile: (relPath: string) => Promise<string>;
  /** run a shell command through the gate; null ⇒ refused. See the module doc's limitation. */
  runShell: (command: string) => Promise<string | null>;
  maxPartChars?: number;
}

export interface ExpandedCommandFile {
  prompt: string;
  rejected: CommandRejection[];
}

/**
 * Parse a composer line as a custom-command invocation: `/name arg1 arg2…`. Returns null when
 * the line isn't a slash command, or names no LOADED command — a plain message with a leading
 * slash-like path (`/etc/hosts please read this`) still requires a SPACE-separated first token
 * that matches a loaded command's name, so an ordinary message is never misdetected.
 */
export function matchCommandFileInvocation(
  text: string,
  commands: readonly IdeLoadedCommandFile[],
): { cmd: IdeLoadedCommandFile; args: string[] } | null {
  if (!text.startsWith("/")) return null;
  const [head, ...rest] = text.trim().split(/\s+/);
  const name = head?.slice(1) ?? "";
  if (!name) return null;
  const cmd = commands.find((c) => c.file.name === name);
  if (!cmd) return null;
  return { cmd, args: rest };
}

/**
 * Expand a loaded command file into the prompt the agent receives — the SAME steps as the
 * CLI's `expandCommand`: gate → resolve `@file`/`!cmd` against the ORIGINAL template → THEN
 * substitute `$1`/`$ARGUMENTS` into the already-resolved text.
 */
export async function expandCommandFile(
  loaded: IdeLoadedCommandFile,
  args: readonly string[],
  deps: ExpandCommandFileDeps,
): Promise<ExpandedCommandFile> {
  const cap = deps.maxPartChars ?? DEFAULT_MAX_PART;
  const scope: CommandScope = loaded.scope;
  const plan = gateCommandFile(loaded.file as CommandFile, scope);
  const rejected = [...plan.rejected];
  let text = loaded.file.template;

  const clip = (s: string): string =>
    s.length > cap ? `${s.slice(0, cap)}\n…[truncated at ${cap} chars]` : s;

  for (const ref of plan.reads) {
    try {
      const body = await deps.readFile(ref);
      text = text.split(`@${ref}`).join(`\n--- ${ref} ---\n${clip(body)}\n--- end ${ref} ---\n`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      rejected.push({ what: `@${ref}`, reason });
      text = text.split(`@${ref}`).join(refusalMarker(`@${ref}`));
    }
  }
  for (const r of plan.rejected) {
    if (r.what.startsWith("@")) text = text.split(r.what).join(refusalMarker(r.what));
  }

  for (const command of plan.runs) {
    const token = `!\`${command}\``;
    const out = await deps.runShell(command);
    text =
      out === null
        ? text.split(token).join(refusalMarker(token))
        : text.split(token).join(`\n--- $ ${command} ---\n${clip(out)}\n--- end ---\n`);
    if (out === null) rejected.push({ what: token, reason: "declined or blocked by the gate" });
  }
  for (const r of plan.rejected) {
    if (r.what.startsWith("!")) text = text.split(r.what).join(refusalMarker(r.what));
  }

  return { prompt: substituteArgs(text, args), rejected };
}
