// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/persona-cmd.ts — `prometheus persona <list|export|import|remove>`: the CLI surface
 * over "persona sharing" — handing one of your own sub-agent persona files (`agents/*.md`, used
 * by `spawn_agent`) to another user, and bringing one of theirs in.
 *
 * THIS FILE DOES NO REAL WORK. Every decision that matters for safety already lives elsewhere:
 *
 *   · `@prometheus/core`'s `agent/agent-files.ts` — `loadAgentFile` clamps PROJECT and IMPORTED
 *     personas IDENTICALLY and HARD (model refused, forced read-only, tools only narrow, body
 *     capped + fenced) purely from which DIRECTORY a file sits in. `scope` is not a field in the
 *     file, so nothing this command prints or writes can talk its way into a higher scope.
 *   · `session/persona-store.ts` — the fs half: `listPersonaFiles`/`exportPersonaMarkdown` (plain
 *     reads of already-permitted files) and `importPersonaMarkdown`/`removeImportedPersona`,
 *     which are STRUCTURALLY confined to `<home>/agents/imported/` (sanitised name via
 *     `agent.agentNameFromFile`, size-capped before any write, and a `resolve()` containment
 *     check) — see that file's header for the full story.
 *
 * This file is only: parse flags, call the store, render a result — mirroring
 * `commands/schedule-cmd.ts`'s shape (small per-subcommand handlers + one dispatcher + a
 * `runPersonaCommandFromCtx(ctx)` adapter for the CLI dispatcher).
 *
 * TWO THINGS THIS FILE ADDS ON TOP OF THE STORE, both belt-and-suspenders rather than the real
 * defence (the real defence is in `persona-store.ts` and `agent-files.ts`):
 *
 *   · `import <file>` REFUSES anything that looks like a URL (`http://`, `https://`, `//`)
 *     before ever touching it — import only ever reads a LOCAL file the user named. This mirrors
 *     a supply-chain lesson (arbitrary fetch of untrusted config) already fixed twice elsewhere
 *     in this codebase; a persona is exactly as dangerous a thing to auto-fetch as either was.
 *   · `import <file>` `stat`s the file and rejects an oversized one BEFORE reading it into
 *     memory at all — the same `MAX_IMPORT_BYTES` cap `persona-store.ts` re-checks on the actual
 *     text (belt-and-suspenders: this is a cheap early-out, not a replacement for that check).
 *
 * `export`'s "no --out" mode prints the raw markdown to stdout UNDECORATED — piping/redirecting
 * it is the whole point of omitting `--out` — so no scope banner is mixed into that stream; the
 * scope only shows up as an informational note when `--out` was given (the file itself has no
 * room for a banner) or inside the `--json` envelope's own fields.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import type { CliContext, CommandJsonEnvelope, CommandOutcome } from "../context.js";
import { prometheusHome } from "../home.js";
import { c, heading, table } from "../render.js";
import {
  exportPersonaMarkdown,
  importPersonaMarkdown,
  listPersonaFiles,
  removeImportedPersona,
} from "../session/persona-store.js";

/** What every subcommand handler produces: human lines (one per `write()` call, no embedded
 *  "\n"), a JSON-able payload for `--json`, and the process exit code. */
export interface HandlerResult {
  lines: string[];
  json: Record<string, unknown>;
  exitCode: number;
}

const USAGE_LINES: string[] = [
  "usage: prometheus persona <list|export|import|remove>",
  "",
  "  list",
  "  export <name> [--out <file>]",
  "  import <file>",
  "  remove <name>",
];

function usageResult(): HandlerResult {
  return { lines: USAGE_LINES, json: { ok: false, error: "usage" }, exitCode: 2 };
}

function errorResult(message: string): HandlerResult {
  return { lines: [c.red(`error: ${message}`)], json: { ok: false, error: message }, exitCode: 2 };
}

/** A minimal `--flag value` / `--flag` parser (mirrors `schedule-cmd.ts`'s own — kept local and
 *  tiny rather than shared, since each command's flag set is small and independent). */
function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

/** A disk-fill guard on the RAW import text, checked via `stat` BEFORE the file is even read
 *  into memory. Mirrors `persona-store.ts`'s own `MAX_IMPORT_BYTES` — this is a cheap early-out,
 *  not a replacement for that check (the store re-checks the actual text regardless). */
const MAX_IMPORT_BYTES = 65536;

/** Import only ever reads a LOCAL file the user named — never fetches network content. A path
 *  that merely LOOKS like a URL is refused outright, before any fs call touches it. */
function looksLikeUrl(p: string): boolean {
  return /^https?:\/\//i.test(p.trim()) || p.trim().startsWith("//");
}

/* ── list ─────────────────────────────────────────────────────────────────── */

export function handleList(cwd: string, home: string): HandlerResult {
  const personas = listPersonaFiles(cwd, home);
  if (personas.length === 0) {
    return { lines: ["no personas found"], json: { ok: true, personas: [] }, exitCode: 0 };
  }
  const rows = personas.map((p) => [
    p.name,
    // An imported-scope persona is clamped identically to a project one (model refused, forced
    // read-only, tools only narrow) — flag it so a user never mistakes it for their own, fully
    // trusted persona.
    p.scope === "imported" ? `${p.scope} (shared, read-only)` : p.scope,
    p.description,
  ]);
  const rendered = table(
    [{ header: "NAME" }, { header: "SCOPE" }, { header: "DESCRIPTION" }],
    rows,
  );
  const lines = [
    heading(`Personas  ${c.dim(`(${personas.length})`)}`),
    "",
    ...rendered.split("\n"),
  ];
  return { lines, json: { ok: true, personas }, exitCode: 0 };
}

/* ── export ───────────────────────────────────────────────────────────────── */

export function handleExport(args: string[], cwd: string, home: string): HandlerResult {
  const name = args[0];
  if (!name) return errorResult("usage: prometheus persona export <name> [--out <file>]");
  const flags = parseFlags(args.slice(1));
  const outPath = flags.out;

  const found = exportPersonaMarkdown(name, cwd, home);
  if (!found) return errorResult(`no such persona: ${name}`);

  if (outPath) {
    writeFileSync(outPath, found.markdown);
    return {
      lines: [`${c.green("✓")} exported "${name}" (from ${found.scope}) to ${outPath}`],
      json: { ok: true, name, scope: found.scope, out: outPath },
      exitCode: 0,
    };
  }

  // No --out: the raw markdown IS the output (piping/redirection is the whole point), so no
  // scope banner or other decoration is mixed into it — `lines` must have no embedded "\n" per
  // HandlerResult's own contract, so split rather than push one giant multi-line string.
  return {
    lines: found.markdown.split("\n"),
    json: { ok: true, name, scope: found.scope, markdown: found.markdown },
    exitCode: 0,
  };
}

/* ── import ───────────────────────────────────────────────────────────────── */

export function handleImport(args: string[], home: string): HandlerResult {
  const filePath = args[0];
  if (!filePath) return errorResult("usage: prometheus persona import <file>");

  // Never fetch network content — import only ever reads a local file the user chose.
  if (looksLikeUrl(filePath)) {
    return errorResult(
      `refusing to import "${filePath}" — import only reads a LOCAL file, never a URL`,
    );
  }

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return errorResult(`no such file: ${filePath}`);
  }
  // Reject an oversized file before it is even read into memory (a cheap early-out on top of
  // persona-store.ts's own re-check of the actual text).
  if (size > MAX_IMPORT_BYTES) {
    return errorResult(`"${filePath}" is too large to import (max ${MAX_IMPORT_BYTES} bytes)`);
  }

  let markdown: string;
  try {
    markdown = readFileSync(filePath, "utf8");
  } catch (err) {
    return errorResult(`could not read "${filePath}": ${(err as Error).message}`);
  }

  const suggestedName = basename(filePath).replace(/\.md$/i, "");
  const result = importPersonaMarkdown(suggestedName, markdown, home);
  if (!result.ok) return errorResult(result.error);

  return {
    lines: [
      `${c.green("✓")} imported "${result.name}" (read-only; cannot choose a model, no matter what the file requests)`,
    ],
    json: {
      ok: true,
      name: result.name,
      path: result.path,
      scope: "imported",
      replaced: result.replaced,
    },
    exitCode: 0,
  };
}

/* ── remove ───────────────────────────────────────────────────────────────── */

export function handleRemove(args: string[], home: string): HandlerResult {
  const name = args[0];
  if (!name) return errorResult("usage: prometheus persona remove <name>");

  const result = removeImportedPersona(name, home);
  if (!result.ok) return errorResult(result.error);

  // removeImportedPersona is a no-op (not an error) when the name was already gone, so this
  // confirmation is accurate either way: the imported persona named `name` does not exist now.
  return {
    lines: [`${c.green("✓")} removed imported persona "${name}"`],
    json: { ok: true, name },
    exitCode: 0,
  };
}

/* ── entry point ──────────────────────────────────────────────────────────── */

export async function runPersonaCommand(
  args: string[],
  opts: { cwd: string; home: string; json: boolean; write: (line: string) => void },
): Promise<{ exitCode: number }> {
  const sub = args[0];
  const rest = args.slice(1);

  let result: HandlerResult;
  switch (sub) {
    case "list":
      result = handleList(opts.cwd, opts.home);
      break;
    case "export":
      result = handleExport(rest, opts.cwd, opts.home);
      break;
    case "import":
      result = handleImport(rest, opts.home);
      break;
    case "remove":
      result = handleRemove(rest, opts.home);
      break;
    default:
      result = usageResult();
      break;
  }

  if (opts.json) {
    opts.write(JSON.stringify(result.json));
  } else {
    for (const line of result.lines) opts.write(line);
  }
  return { exitCode: result.exitCode };
}

/**
 * The `prometheus persona …` dispatcher entry point (index.ts's one-line registration, mirroring
 * `schedule-cmd.ts`'s `runTasksCommand(ctx)`). Reconstructs a raw flag/positional argv from the
 * already-parsed `ParsedArgs` — this subcommand set's own grammar (one bare subcommand token,
 * then either a bare positional (`export <name>`/`import <file>`/`remove <name>`) optionally
 * followed by `--flag value` pairs (`export`'s `--out`)) round-trips losslessly through
 * `[...positionals, ...flagPairs]`.
 */
export async function runPersonaCommandFromCtx(ctx: CliContext): Promise<CommandOutcome> {
  const flagArgs = Object.entries(ctx.args.flags).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, value],
  );
  const rawArgs = [...ctx.args.positionals, ...flagArgs];

  const lines: string[] = [];
  let jsonPayload: CommandJsonEnvelope | undefined;
  const { exitCode } = await runPersonaCommand(rawArgs, {
    cwd: ctx.args.cwd ?? process.cwd(),
    home: prometheusHome(),
    json: ctx.json,
    write: (line) => {
      if (ctx.json) {
        try {
          jsonPayload = JSON.parse(line) as CommandJsonEnvelope;
        } catch {
          /* a progress line slipped through outside --json's single-object contract; drop it */
        }
      } else {
        lines.push(line);
      }
    },
  });

  return {
    text: lines.join("\n"),
    json: jsonPayload ?? { ok: exitCode === 0 },
    exitCode,
  };
}
