/**
 * toEngineArgv.ts — map parsed §1 global flags → engine argv (file 11 §1, PURE).
 *
 * The engine's discipline (verified in prometheus.py build_parser, mirrored by the
 * MCP server's toArgv): GLOBAL FLAGS come BEFORE the subcommand —
 * `["--dry-run","--yes","install","foo"]`, never after. `--json`/`--no-color` are NOT
 * forwarded here: the bridge (runPrometheus) prepends them itself, and they are the
 * CLI's output concern, not a command flag.
 */
import type { ParsedArgs } from "./parse.js";

/** The §1 engine globals in canonical order (before the subcommand). */
export function globalArgv(p: ParsedArgs): string[] {
  const out: string[] = [];
  if (p.dryRun) out.push("--dry-run");
  if (p.yes) out.push("--yes");
  if (p.strict) out.push("--strict");
  if (p.force) out.push("--force");
  if (p.noGate) out.push("--no-gate");
  if (p.gateMode) out.push("--gate-mode", p.gateMode);
  if (p.verbose) out.push("--verbose");
  return out;
}

/** Build engine argv: [globals…, subcommand…, extra…]. */
export function toEngineArgv(
  p: ParsedArgs,
  subcommand: string | string[],
  extra: string[] = [],
): string[] {
  const sub = Array.isArray(subcommand) ? subcommand : [subcommand];
  return [...globalArgv(p), ...sub, ...extra];
}
