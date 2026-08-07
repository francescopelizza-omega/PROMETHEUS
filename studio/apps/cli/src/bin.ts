#!/usr/bin/env node
/**
 * bin.ts — the `prometheus` CLI entrypoint. Reads argv, sets up color, dispatches to
 * the command, prints the outcome, and exits with the command's exit code.
 *
 * This is the ONLY file that touches process.argv / process.stdout / process.exit
 * so the dispatcher (index.ts) and every command stay unit-testable. Security
 * verdicts are produced by engine-bridge/nemesis; this file only renders and
 * propagates the exit code (C5).
 */
import { createInterface } from "node:readline";

import { createEngineClient } from "@prometheus/engine-bridge";

import { dispatch } from "./index.js";
import { type ParsedArgs, parseArgs } from "./parse.js";
import {
  defaultColorEnabled,
  defaultUnicodeEnabled,
  emitJson,
  setColorEnabled,
  setUnicodeEnabled,
} from "./render.js";
import { readStdinPrompt, shouldReadStdinPrompt } from "./stdin.js";
import { isTerminalChatLaunch, routeTerminalChat } from "./terminal/chat-route.js";
import { launchTmuxSession } from "./tmux/multiplexer.js";
import { TUI_NOT_TTY, launchTui } from "./tui/index.js";

/**
 * A readline typed-confirm for a one-shot bypass LAUNCH (never-force). Resolves
 * true ONLY when the user types the exact `phrase`; EOF / mismatch → false (deny).
 * Closes the interface on every path so the process never hangs.
 */
function readlineConfirm(prompt: string, phrase: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    // EOF / a closed stdin (Ctrl-D, a pipe that ends) must DENY (fail-closed) — the answer callback
    // never fires on EOF, so without this the never-force gate would hang or resolve as success.
    rl.on("close", () => finish(false));
    rl.question(`${prompt}: `, (answer) => finish(answer.trim() === phrase));
  });
}

// The OPTIONAL Ink renderer lives under ./repl/, EXCLUDED from this tsc build (ink
// is a packaging-time dep). It is loaded via a NON-LITERAL specifier so the type-check
// never requires it; it is opt-in only (`prometheus --ink`). If it (or ink) is absent we fall
// back to the zero-dep node:readline session host below.
async function launchInkRepl(parsed: ParsedArgs): Promise<boolean> {
  try {
    const spec = "./repl/run.js";
    const mod = (await import(spec)) as { runRepl?: (p: ParsedArgs) => Promise<void> };
    if (typeof mod.runRepl !== "function") return false;
    await mod.runRepl(parsed);
    return true;
  } catch {
    return false; // ink absent → the readline session host takes over.
  }
}

/**
 * Does this invocation want the interactive single-window session? Bare `prometheus`,
 * `prometheus repl`, `prometheus tui`, and a bare `prometheus chat` (no message / no --local / --cli)
 * all land in the session host. `chat --local`/`--cli` + every other verb stay
 * one-shot and route through dispatch().
 */
function wantsInteractiveSession(parsed: ParsedArgs): boolean {
  if (parsed.version || parsed.help) return false;
  if (parsed.repl) return true; // bare `prometheus`
  const head = parsed.command[0];
  if (head === "repl" || head === "tui" || head === "session") return true;
  if (
    head === "chat" &&
    parsed.positionals.length === 0 &&
    parsed.flags.local === undefined &&
    parsed.flags.cli === undefined
  ) {
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  // Color: default from TTY/NO_COLOR, force-off when --no-color or --json.
  setColorEnabled(defaultColorEnabled() && !parsed.noColor && !parsed.json);
  // CLI-097: unicode glyphs degrade to ASCII on a dumb terminal (orthogonal to color).
  setUnicodeEnabled(defaultUnicodeEnabled());

  // CLI-083: `prometheus chat` with piped/redirected stdin (no positional message, not `--cli`) reads the
  // prompt from stdin — `cat task.md | prometheus chat`. Done HERE, before any readline is created (else
  // the two would compete for the stream), and BEFORE the interactive check below so the injected
  // positional makes it a one-shot (a real positional message takes precedence — stdin is fallback).
  if (
    shouldReadStdinPrompt(parsed.command, parsed.positionals, parsed.flags, process.stdin.isTTY)
  ) {
    const piped = await readStdinPrompt();
    if (piped.error) {
      if (parsed.json) emitJson({ ok: false, error: piped.error });
      else process.stderr.write(`prometheus chat: ${piped.error}\n`);
      process.exitCode = 2;
      return;
    }
    parsed.positionals.push(piped.text as string);
  }

  // Interactive single-window session (§1): bare `prometheus`, `prometheus repl|tui`, bare `chat`.
  // Needs a TTY; without one we fall through to dispatch() (json/stub contract intact).
  if (wantsInteractiveSession(parsed) && process.stdin.isTTY === true) {
    // `--ink` opts into the optional Ink renderer; default = zero-dep readline host.
    if (parsed.flags.ink === true && (await launchInkRepl(parsed))) return;
    // The DEFAULT interactive surface is the rich raw-mode TUI (resizable composer +
    // slash autocomplete + permission modes + sudo gate). `--plain` / `--tmux` /
    // PROMETHEUS_TMUX=1 opt out to the readline / tmux host; a non-TTY TUI returns
    // TUI_NOT_TTY and we fall back to the same host.
    // a flag is "set" when present and not explicitly disabled — `--plain`, `--plain=1`,
    // and `--plain true` all count; `--plain=0`/`false` do not. (parse stores `string|true`.)
    const flagOn = (v: string | true | undefined): boolean =>
      v === true || (typeof v === "string" && v !== "" && v !== "0" && v !== "false");
    const wantsTmuxOrPlain =
      flagOn(parsed.flags.plain) ||
      flagOn(parsed.flags.tmux) ||
      process.env.PROMETHEUS_TMUX === "1";
    if (!wantsTmuxOrPlain) {
      const code = await launchTui(parsed);
      if (code !== TUI_NOT_TTY) {
        process.exitCode = code;
        return;
      }
    }
    // launchTmuxSession spans multiple windows when tmux is present + enabled
    // (--tmux / PROMETHEUS_TMUX=1), else falls back to the single-window host.
    process.exitCode = await launchTmuxSession(parsed);
    return;
  }

  // One-shot terminal-chat LAUNCH (`prometheus chat --cli X --open|--tmux`): the engine
  // returns the injection-safe argv and we spawn it ourselves (a live pty / tmux).
  // Owned here (not dispatch) because it drives the real terminal. A bypass launch
  // type-confirms over readline on a TTY; with no TTY there is no confirm → denied.
  if (isTerminalChatLaunch(parsed)) {
    const outcome = await routeTerminalChat(parsed, {
      client: createEngineClient(),
      json: parsed.json,
      write: (t) => void process.stderr.write(`${t}\n`),
      ...(process.stdin.isTTY === true ? { confirm: readlineConfirm } : {}),
    });
    // always emit a machine envelope under --json (mirrors dispatch) — never a silent empty stdout.
    if (parsed.json) emitJson(outcome.json ?? { ok: outcome.exitCode === 0 });
    else if (outcome.text) process.stdout.write(`${outcome.text}\n`);
    process.exitCode = outcome.exitCode;
    return;
  }

  let outcome: Awaited<ReturnType<typeof dispatch>>;
  try {
    outcome = await dispatch(parsed);
  } catch (err) {
    // Last-ditch guard: never crash with a stack the user can't act on.
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      emitJson({ ok: false, error: message });
    } else {
      process.stderr.write(`prometheus: fatal: ${message}\n`);
    }
    process.exitCode = 2;
    return;
  }

  if (parsed.json) {
    emitJson(outcome.json ?? { ok: outcome.exitCode === 0 });
  } else if (outcome.text !== undefined && outcome.text !== "") {
    process.stdout.write(`${outcome.text}\n`);
  }

  process.exitCode = outcome.exitCode;
}

/** A friendly one-line message for any thrown value — NEVER a raw stack (§6). */
function friendly(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Process-level crash guards (§6 crash-free): a stray rejection or a late async
// throw renders an actionable one-liner + a nonzero exit, never a raw stack trace.
// An interactive session/pty/tmux child failure already degrades in-loop; these are
// the absolute backstop so the CLI can NEVER terminate on an uncaught error.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`prometheus: unexpected: ${friendly(reason)}\n`);
  process.exitCode = 2;
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`prometheus: unexpected: ${friendly(err)}\n`);
  process.exitCode = 2;
});

main().catch((err) => {
  process.stderr.write(`prometheus: unexpected: ${friendly(err)}\n`);
  process.exitCode = 2;
});
