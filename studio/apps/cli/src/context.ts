/**
 * context.ts — the per-invocation CLI context handed to every command.
 *
 * Holds the single EngineClient (the ONLY JS->engine gateway, C5) and the
 * global view flags (json/color). Commands receive this, do their work via the
 * client / sidecar runner, and return a CommandOutcome (text OR json + exit
 * code). bin.ts owns process.exit so commands stay testable & side-effect-light.
 */
import { type EngineClient, createEngineClient, isEngineError } from "@prometheus/engine-bridge";

import type { ParsedArgs } from "./parse.js";
import { discoverProjectConfigPath } from "./profile-store.js";

export interface CliContext {
  client: EngineClient;
  json: boolean;
  /** CLI-085: `--quiet`/`-q` — suppress cosmetic chatter (progress ticks, hints, non-essential
   *  banners, `Log.info`-style lines). NEVER suppresses the command RESULT, ERRORS, or a
   *  SECURITY-relevant warning (a nemesis warn/block reason, a degraded-scan caveat). */
  quiet: boolean;
  /** raw parsed args (positionals + flags) for the command. */
  args: ParsedArgs;
  /** the discovered per-project `.prom.toml` path, if any (CLI-046). */
  projectConfigPath?: string;
}

/** Once-per-process guard so the `using project config` line announces exactly once (REPL calls
 *  makeContext more than once); stdout must stay one-JSON-object under --json. */
let projectAnnounced = false;

/**
 * The shared `--json` envelope (CLI-084): EVERY command's machine payload carries at least `ok`
 * (a script can branch on `.ok` uniformly). Commands add their own fields via an intersection —
 * `CommandJsonEnvelope & { entries: Row[] }` — rather than the index signature (which would type
 * every read as `unknown`). `ok` is required; extra keys are free.
 */
export interface CommandJsonEnvelope {
  ok: boolean;
  [key: string]: unknown;
}

/** What a command returns: lines to print, an optional json payload, an exit code. */
export interface CommandOutcome {
  /** pretty text (already colored) to write to stdout. */
  text?: string;
  /** machine payload to emit when ctx.json is true — the shared `{ok, …}` envelope (CLI-084). */
  json?: CommandJsonEnvelope;
  /** process exit code (0 default). */
  exitCode: number;
}

/**
 * CLI-085: should cosmetic PROGRESS/chatter be suppressed? True under `--json` (stdout must stay a
 * clean single object for `jq`) OR `--quiet` (the explicit low-noise knob). NEVER gates the result,
 * errors, or a security-relevant warning — only progress ticks / hints / non-essential banners.
 */
export function suppressProgress(ctx: { json: boolean; quiet: boolean }): boolean {
  return ctx.json || ctx.quiet;
}

/**
 * Build the per-invocation context.
 *
 * `client` is an OPTIONAL pre-built gateway: the interactive session already owns one
 * EngineClient for its whole lifetime (C5 — one gateway), so it hands that instance in
 * instead of letting every verb mint a second connection. Omitted (the one-shot CLI) →
 * a fresh client, exactly as before.
 */
export function makeContext(args: ParsedArgs, client?: EngineClient): CliContext {
  // Discover a per-project `.prom.toml` (CLI-046) and announce it ONCE on stderr (never under
  // --json, never on stdout). PROM_NO_PROJECT_CONFIG=1 short-circuits inside discoverProjectConfigPath.
  const projectConfigPath = discoverProjectConfigPath(args.cwd ?? process.cwd());
  if (projectConfigPath && !args.json && !projectAnnounced) {
    projectAnnounced = true;
    process.stderr.write(`using project config: ${projectConfigPath}\n`);
  }
  return {
    client: client ?? createEngineClient(),
    json: args.json,
    quiet: args.quiet,
    args,
    ...(projectConfigPath ? { projectConfigPath } : {}),
  };
}

/**
 * The `prometheus` exit-code convention (CLI-084) — the SINGLE reference table. Every command's
 * failure exit MUST map onto this; `outcomeFromError` below is the ONE place a thrown error
 * becomes an exit code (a command hand-rolling its own error→code mapping is a divergence to fix):
 *
 *   0  success
 *   1  generic command failure (bad args, not-found, a non-security operation failed)
 *   2  fail-closed SECURITY / ENGINE block — a nemesis BLOCK, a transport/scan failure, a
 *      confirm/typed-token refusal. Load-bearing for CI (`$? -eq 2` detects a security block);
 *      NEVER renumber a correct 2.
 *
 * Documented exceptions (a genuinely different, intentional contract):
 *   • `prometheus secure scan` uses a 0/1/2 scripting map (allow=0 · warn=1 · block/error=2), distinct
 *     from `prometheus gate`'s nemesis-mirroring 0/10/20/2 — both are deliberate per CLI-040/CLI-039.
 */

/** Clamp a raw exit code to a valid non-zero FAILURE code (CLI-084): a bogus/absent/0/256-wrap
 *  value can never be reported as success — an error is always ≥1. */
export function failureCode(raw: unknown): number {
  return Number.isInteger(raw) && (raw as number) >= 1 && (raw as number) <= 255
    ? (raw as number)
    : 1;
}

/**
 * Turn any thrown error into a uniform CommandOutcome. EngineError fail-closed
 * codes map to a BLOCK-style exit (2) so the CLI never exits 0 on a transport
 * failure (C5). A stale/out-of-range `err.exitCode` is clamped so a fail never wraps to success.
 */
export function outcomeFromError(err: unknown): CommandOutcome {
  if (isEngineError(err)) {
    const code = err.failClosed ? 2 : failureCode(err.exitCode ?? 1);
    return {
      text: `error (${err.code}): ${err.message}${err.stderrTail ? `\n${err.stderrTail}` : ""}`,
      json: { ok: false, error: err.message, code: err.code, exitCode: code },
      exitCode: code,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    text: `error: ${message}`,
    json: { ok: false, error: message, exitCode: 1 },
    exitCode: 1,
  };
}
