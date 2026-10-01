// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * terminal/chat-route.ts — lift a parsed `chat --cli …` invocation into the P5/P6
 * terminal-chat handoff (runTerminalChat). This is the ONE place that maps
 * `ParsedArgs` → `TerminalChatOpts`, so both surfaces share it:
 *   - one-shot   `prometheus chat --cli claude --open`  (bin.ts owns the readline confirm),
 *   - in-session `chat --cli claude --tmux`        (command-exec.ts passes the host's
 *                                                   typed-confirm + write seam).
 *
 * A bare `chat --cli X` with NO launch switch is NOT a launch — it falls through to
 * the registry preview (the engine's assembled argv as text). Only `--open` / `--tmux`
 * route here. engine-handoff stays pure of parsing (its doc contract); this module is
 * the thin parse→opts adapter, kept tiny + unit-tested.
 */
import type { EngineClient } from "@prometheus/engine-bridge";

import type { CommandOutcome } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { type TerminalChatOpts, runTerminalChat } from "./engine-handoff.js";

/** The minimal context the chat router needs from its caller (one-shot OR session). */
export interface ChatRouteCtx {
  /** the ONLY engine gateway (C5), shared with the rest of the CLI/session. */
  client: EngineClient;
  /** machine output mode (drives the preview JSON payload). */
  json: boolean;
  /** human output channel for notes/preview/decline lines (default: stderr). */
  write?: (text: string) => void;
  /** typed-confirm for a bypass LAUNCH (never-force); absent → bypass denied. */
  confirm?: (prompt: string, phrase: string) => Promise<boolean>;
  /**
   * Force a PREVIEW (no spawn) even when --open/--tmux are present. Used by the
   * in-session path: launching a nested interactive terminal would fight the host's
   * readline for stdin, so the session previews + hints the one-shot launch instead.
   */
  previewOnly?: boolean;
}

/**
 * Is this parsed invocation a terminal-chat LAUNCH — `chat --cli <svc>` carrying a
 * launch switch (`--open` or `--tmux`)? A preview (`chat --cli X` alone) is NOT a
 * launch and must keep routing through the parity registry.
 */
export function isTerminalChatLaunch(parsed: ParsedArgs): boolean {
  if (!isTerminalChatCli(parsed)) return false;
  return parsed.flags.open === true || parsed.flags.tmux !== undefined;
}

/**
 * Is this a TERMINAL chat invocation at all — `chat --cli <svc>` (with or without a
 * launch switch, but NOT the agentic `--local` path)? A plain one (no --open/--tmux)
 * routes to the rich PREVIEW (argv + engine notes) instead of the registry summary.
 */
export function isTerminalChatCli(parsed: ParsedArgs): boolean {
  if (parsed.command[0] !== "chat") return false;
  if (parsed.flags.local !== undefined) return false; // --local is the agentic path
  return typeof parsed.flags.cli === "string" && parsed.flags.cli.length > 0;
}

/** A captured flag as a non-empty string, else undefined. */
function flagStr(flags: ParsedArgs["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Build TerminalChatOpts from the parsed args + context, then run the handoff. The
 * handoff returns a number (exit code) when it LAUNCHED (the child/tmux owned the
 * terminal) or a CommandOutcome when it PREVIEWED; we normalise both to a
 * CommandOutcome the caller renders / propagates the exit code from.
 */
export async function routeTerminalChat(
  parsed: ParsedArgs,
  ctx: ChatRouteCtx,
): Promise<CommandOutcome> {
  const tmuxFlag = ctx.previewOnly ? undefined : parsed.flags.tmux;
  const opts: TerminalChatOpts = {
    // guarded upstream by isTerminalChatCli/Launch (cli is a non-empty string); fall back
    // to "" rather than the literal "undefined" so a stray call fails closed at the engine.
    cli: flagStr(parsed.flags, "cli") ?? "",
    client: ctx.client,
    json: ctx.json,
    open: ctx.previewOnly ? false : parsed.flags.open === true,
    ...(tmuxFlag !== undefined ? { tmux: tmuxFlag === true ? true : String(tmuxFlag) } : {}),
    ...(flagStr(parsed.flags, "model") ? { model: flagStr(parsed.flags, "model") } : {}),
    ...(flagStr(parsed.flags, "system-prompt")
      ? { systemPrompt: flagStr(parsed.flags, "system-prompt") }
      : {}),
    ...(parsed.flags["replace-system"] === true ? { replaceSystem: true } : {}),
    ...(parsed.flags.bypass === true ? { bypass: true } : {}),
    ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
    ...(parsed.positionals[0] ? { prompt: parsed.positionals[0] } : {}),
  };

  const deps = {
    ...(ctx.write ? { write: ctx.write } : {}),
    ...(ctx.confirm ? { confirm: ctx.confirm } : {}),
  };

  const res = await runTerminalChat(opts, deps);
  // LAUNCHED → the child/tmux already drove the terminal; carry its exit code.
  if (typeof res === "number") return { exitCode: res };
  // PREVIEWED → a CommandOutcome the caller renders.
  return res;
}
