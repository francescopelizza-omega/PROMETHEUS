// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/loader.ts — markdown command-file loader (file 14 §3.2).
 *
 * User-defined slash commands as `.md` files (`.prometheus/command/*.md` + global):
 * filename → `/name`, `$ARGUMENTS`/`$1`/`$2` substitution, `@filepath` refs, ``!`cmd` ``
 * shell injection, + frontmatter (description/agent/model/subtask). PURE: it PARSES +
 * substitutes user args, and DETECTS `@file`/`!cmd` boundaries — it NEVER reads a file
 * or runs a command. Those are gate boundaries (C12): the caller resolves `@file` via
 * the FS tool and runs `!cmd` through the nemesis gate, exactly like any terminal command.
 */

/** A command-file argument hint (mapped to a SlashCommand.arg string). */
export interface CommandArg {
  name: string;
  description?: string;
  required?: boolean;
}

/** A parsed command file (the prompt template + selection metadata). */
export interface CommandFile {
  /** slash name derived from the filename (e.g. "review-pr.md" → "review-pr"). */
  name: string;
  description?: string;
  /** front-matter agent/model selection + subtask flag (§3.2). */
  agent?: string;
  model?: string;
  subtask?: boolean;
  args: CommandArg[];
  /** the body, with `$…`/`@…`/`!…` left intact (substitution happens at run time). */
  template: string;
  /** detected `@filepath` refs — the caller resolves them via the FS tool (gated if remote). */
  fileRefs: string[];
  /** detected ``!`cmd` `` shell injections — the caller runs them THROUGH THE GATE (C12). */
  shellInjections: string[];
}

/** A ParseError mirrors themes/loader fail-soft (never throws). */
export type CommandParseOutcome = { ok: true; file: CommandFile } | { ok: false; reason: string };

const FILE_REF_RE = /@([^\s`]+)/g;
const SHELL_INJ_RE = /!`([^`]+)`/g;

/** Derive the slash name from a command filename. */
export function commandNameFromFile(filename: string): string {
  return filename.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/i, "");
}

function parseFrontmatter(markdown: string): {
  meta: Record<string, string | boolean>;
  body: string;
} {
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!fm) return { meta: {}, body: markdown.trim() };
  const meta: Record<string, string | boolean> = {};
  for (const line of (fm[1] as string).split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const raw = (m[2] as string).trim().replace(/^["']|["']$/g, "");
    meta[m[1] as string] = raw === "true" ? true : raw === "false" ? false : raw;
  }
  return { meta, body: (fm[2] as string).trim() };
}

/**
 * Blank out every ``!`cmd` `` span so the `@ref` scan cannot see inside one.
 *
 * An `@` inside a shell injection belongs to the COMMAND — `npm view react@latest`, `git diff
 * @{u}`, `docker run img@sha256:…` — not to a file the caller should read. Reporting it as both
 * was destructive rather than merely noisy: the expanders resolve reads FIRST and rewrite every
 * occurrence of `@ref` in the template, which mutates the very ``!`cmd` `` token the runs loop
 * then splits on. The split stops matching, so in user scope the command is confirmed by the
 * human, executed through the gate, and its output silently dropped; in project scope the
 * refusal marker lands nowhere, which is exactly the silent-gap failure `refusalMarker` exists
 * to prevent. Spaces preserve the body's length so nothing else shifts.
 */
function maskShellInjections(body: string): string {
  return body.replace(SHELL_INJ_RE, (m) => " ".repeat(m.length));
}

/** Parse a command file (fail-soft). `filename` provides the slash name. */
export function parseCommandFile(filename: string, markdown: string): CommandParseOutcome {
  const name = commandNameFromFile(filename);
  if (!name) return { ok: false, reason: "empty command name" };
  const { meta, body } = parseFrontmatter(markdown);
  const fileRefs = [...maskShellInjections(body).matchAll(FILE_REF_RE)].map((m) => m[1] as string);
  const shellInjections = [...body.matchAll(SHELL_INJ_RE)].map((m) => m[1] as string);
  return {
    ok: true,
    file: {
      name,
      ...(typeof meta.description === "string" ? { description: meta.description } : {}),
      ...(typeof meta.agent === "string" ? { agent: meta.agent } : {}),
      ...(typeof meta.model === "string" ? { model: meta.model } : {}),
      ...(meta.subtask === true ? { subtask: true } : {}),
      args: argSpecFromBody(body),
      template: body,
      fileRefs: [...new Set(fileRefs)],
      shellInjections: [...new Set(shellInjections)],
    },
  };
}

/** Infer positional args from `$1`..`$9` + `$ARGUMENTS` usage in the body. */
function argSpecFromBody(body: string): CommandArg[] {
  const args: CommandArg[] = [];
  const nums = new Set([...body.matchAll(/\$([1-9])/g)].map((m) => Number(m[1])));
  for (const n of [...nums].sort((a, b) => a - b)) args.push({ name: `arg${n}`, required: true });
  if (body.includes("$ARGUMENTS")) args.push({ name: "ARGUMENTS", description: "all arguments" });
  return args;
}

/**
 * Substitute `$ARGUMENTS` (all args joined) + `$1`..`$9` (positional) in the template.
 * PURE string work — `@file`/`!cmd` are intentionally NOT resolved here (gate boundary).
 */
export function substituteArgs(template: string, args: readonly string[]): string {
  let out = template.replaceAll("$ARGUMENTS", args.join(" "));
  out = out.replace(/\$([1-9])/g, (_m, d: string) => args[Number(d) - 1] ?? "");
  return out;
}

/** A slash command shape (mirrors repl/slash.ts SlashCommand). */
export interface CompiledSlash {
  name: string;
  arg?: string;
  description: string;
}

/** Compile a command file into a slash command (the `arg` is a human hint, §3.2). */
export function commandFileToSlash(file: CommandFile): CompiledSlash {
  const argHint =
    file.args.length > 0
      ? file.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ")
      : undefined;
  return {
    name: file.name,
    ...(argHint ? { arg: argHint } : {}),
    description: file.description ?? `user command (${file.name}.md)`,
  };
}

/** Compile many parsed files into slash commands (skips parse failures). */
export function commandFilesToSlashes(files: readonly CommandFile[]): CompiledSlash[] {
  return files.map(commandFileToSlash);
}

/** Whether a `@ref` is a remote URL (the fetch MUST be gated, C12). */
export function isRemoteRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}
