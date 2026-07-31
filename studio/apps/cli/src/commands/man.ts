/**
 * commands/man.ts — `prom man`: a roff-formatted man page generated from CLI-049's `COMMAND_SPECS`
 * registry (CLI-100). Same single source as help + completions — never a hand-maintained document.
 *
 * roff escaping (users COPY flags out of a man page): backslash → `\e`, and a literal `-` → `\-` so
 * a flag renders as a copyable minus, not a typographic hyphen. Pure string builder — no IO/clock;
 * the date + version are injected so it's deterministic + testable.
 */
import { COMMAND_SPECS } from "@prometheus/core";

import type { CliContext, CommandOutcome } from "../context.js";
import { PROM_VERSION } from "./help.js";

/** roff-escape body text: backslash first (→ `\e`), then literal hyphens (→ `\-`, a copyable minus). */
function roff(s: string): string {
  return s.replace(/\\/g, "\\e").replace(/-/g, "\\-");
}

/** Collapsed one-line description for a command (from CLI-049 help/description). */
function desc(id: string): string {
  const spec = COMMAND_SPECS.find((c) => c.id === id);
  return (spec?.description ?? spec?.help?.synopsis ?? id).replace(/\s+/g, " ").trim();
}

const GLOBAL_OPTIONS: ReadonlyArray<[string, string]> = [
  ["--json", "Emit a single machine JSON object to stdout (zero ANSI)."],
  ["--no-color", "Disable ANSI color (also honors NO_COLOR / a dumb terminal)."],
  ["--quiet", "Suppress cosmetic progress/hints (never the result or a security warning)."],
  ["--dry-run", "Preview a mutating command without performing it."],
  ["--yes", "Assume yes for non-security confirmations (never bypasses a nemesis block)."],
  ["--profile <name>", "Use the named profile's tuning + system prompt."],
  ["--version", "Print the prom + engine version and exit."],
  ["--help", "Print usage and exit."],
];

/**
 * Render the `prom(1)` man page (CLI-100). `date` (ISO `YYYY-MM-DD`) + `version` are injected for
 * determinism. Commands come from `COMMAND_SPECS`; global options are the parse.ts §1 flags.
 */
export function manPage(opts: { version?: string; date?: string } = {}): string {
  const version = opts.version ?? PROM_VERSION;
  const date = opts.date ?? "";
  const cmds = [...new Set(COMMAND_SPECS.map((c) => c.id))].sort();
  const lines: string[] = [
    `.TH PROM 1 "${date}" "prom ${roff(version)}" "Prometheus Studio"`,
    ".SH NAME",
    "prom \\- Prometheus Studio terminal CLI (scan / gate / install over the engine)",
    ".SH SYNOPSIS",
    ".B prom",
    "[\\fB\\-\\-json\\fR] [\\fB\\-\\-no\\-color\\fR] \\fICOMMAND\\fR [\\fIargs\\fR]",
    ".SH DESCRIPTION",
    "prom renders the security verdicts the Prometheus engine (prometheus.py / nemesis) produces and",
    "mirrors the decision tier into its exit code; it never decides safety itself.",
    ".SH COMMANDS",
  ];
  for (const id of cmds) {
    lines.push(".TP", `\\fB${roff(id)}\\fR`, roff(desc(id)));
  }
  lines.push(".SH OPTIONS");
  for (const [flag, help] of GLOBAL_OPTIONS) {
    lines.push(".TP", `\\fB${roff(flag)}\\fR`, roff(help));
  }
  lines.push(
    ".SH ENVIRONMENT",
    ".TP",
    "\\fBPROMETHEUS_PY\\fR, \\fBNEMESIS_BIN\\fR",
    "Locate the engine + scanner when not on PATH (required for the SEA binary / a bare npm install).",
    ".SH EXIT STATUS",
    "0 allow \\(bu 10 warn \\(bu 20 block \\(bu 2 fail\\-closed security/engine error.",
  );
  return `${lines.join("\n")}\n`;
}

/** `prom man` — print the roff man page to stdout (`prom man | man -l -`). */
export function runMan(ctx: CliContext): CommandOutcome {
  const page = manPage({});
  if (ctx.json) return { json: { ok: true, format: "roff", page }, exitCode: 0 };
  return { text: page, exitCode: 0 };
}
