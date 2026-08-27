/**
 * terminal/engine-handoff.ts — the one-shot `chat --cli <svc>` control flow (P5).
 *
 * This is the single place that turns a parsed `chat --cli …` into one of three
 * outcomes, all driven by the engine's PREVIEW (the engine returns the assembled,
 * injection-safe argv + env + notes; JS NEVER hand-builds a terminal argv — C5):
 *
 *   - default (no --open, no --tmux) → a read-only PREVIEW CommandOutcome: the
 *     label, the engine's notes VERBATIM, and the exact argv that OPEN would run.
 *     Nothing is launched; the human inspects first.
 *   - --open  → hand the envelope to the live-terminal seam (`runLiveTerminal`),
 *     which spawns the previewed argv (pty in-session / inherited child fallback),
 *     streams it, and restores the TTY on every exit path.
 *   - --tmux  → hand the envelope to the tmux seam (`runTmux`), which mirrors the
 *     engine's `_tmux_launch` (has-session idempotent guard → new-session → attach).
 *
 * NEVER-FORCE / GATE-FIRST: when the engine's preview reports `bypass:true`
 * (`--dangerously-skip-permissions` / `--bypass`), we hold the LAUNCH behind a
 * typed-confirm (the human types the exact phrase) BEFORE spawning. We decide
 * nothing about safety — we only require the human to acknowledge they are
 * overriding the engine's verdict. The preview path never gates (nothing runs).
 *
 * CRASH-FREE: a thrown engine/transport error, a missing seam, or a launch
 * failure becomes a friendly CommandOutcome / non-zero code — never a raw stack.
 * The two spawning surfaces (live terminal + tmux) are INJECTED seams so this
 * module unit-tests fully without a pty, a tmux binary, or a real engine. The
 * pure builders (opts→ChatPreviewOpts, envelope→preview text, the bypass phrase)
 * live in ./preview.ts and are tested there in isolation.
 */
import {
  type ChatPreviewOpts,
  type ChatTerminalEnvelope,
  Commands,
} from "@prometheus/engine-bridge";
import type { EngineClient } from "@prometheus/engine-bridge";

import type { CommandOutcome } from "../context.js";
import { outcomeFromError } from "../context.js";
import {
  BYPASS_PHRASE,
  bypassConfirmPrompt,
  previewOutcome,
  toChatPreviewOpts,
} from "./preview.js";

/* ------------------------------------------------------------------------- *
 * Inputs.
 * ------------------------------------------------------------------------- */

/**
 * Everything the one-shot `chat --cli` flow needs. Built by the dispatcher from
 * the parsed CLI args (the wiring that lifts these off `ParsedArgs` is a SHARED
 * edit in index.ts — see sharedEditsProposed; this module stays pure of parsing).
 *
 *  - `cli`          the service key (claude/codex/gemini/cursor/opencode/…).
 *  - `open`/`tmux`  the two LAUNCH switches (mutually preferred: tmux wins when
 *                   both are present, mirroring the engine's `--tmux` precedence).
 *  - the rest map 1:1 to ChatPreviewOpts (model/systemPrompt/replaceSystem/
 *    bypass/cwd/prompt). `bypass` here only PRE-REQUESTS the engine bypass flag;
 *    the LAUNCH gate keys off the engine's returned `bypass`, never this input.
 */
export interface TerminalChatOpts {
  /** the chat service key (engine CHAT_CLIS). Required. */
  cli: string;
  /** launch a single live terminal (the engine's `--open`). */
  open?: boolean;
  /** wrap in tmux: true = default session name, string = a named session. */
  tmux?: string | boolean;
  /** request the engine emit `--model M`. */
  model?: string;
  /** path to a system-prompt file (appended unless `replaceSystem`). */
  systemPrompt?: string;
  replaceSystem?: boolean;
  /** request the engine's permission-override flag in the previewed argv. */
  bypass?: boolean;
  /** working directory for the terminal session. */
  cwd?: string;
  /** one-shot prompt (omit → interactive). */
  prompt?: string;
  /** the ONLY engine gateway (C5) — shared with the rest of the CLI/session. */
  client: EngineClient;
  /** machine output mode (drives the preview JSON payload). */
  json: boolean;
}

/* ------------------------------------------------------------------------- *
 * Injected seams (faked in tests; defaults lazy-load the sibling modules).
 * ------------------------------------------------------------------------- */

/**
 * The spawning surfaces this module hands the engine's envelope to. Both are
 * INJECTED so the handoff unit-tests without a pty/tmux/engine; the production
 * defaults lazy-import the sibling P5/P6 modules (so a missing optional backend
 * never breaks import, and the tmux module owns the TmuxSpec shape, not us).
 */
export interface TerminalChatDeps {
  /** P5: spawn the previewed argv as a live terminal; returns the child's code. */
  runLiveTerminal?: (env: ChatTerminalEnvelope) => Promise<number>;
  /** P6: wrap the previewed argv in a tmux session; returns the tmux exit code. */
  runTmux?: (env: ChatTerminalEnvelope) => Promise<number>;
  /**
   * Type-confirm the bypass LAUNCH (never-force). Resolves true ONLY on an exact
   * phrase match; a non-interactive host resolves false (deny). When absent the
   * launch is DENIED (fail-closed) rather than silently proceeding.
   */
  confirm?: (prompt: string, phrase: string) => Promise<boolean>;
  /** human output channel (the preview/notes/decline lines). Defaults to stderr. */
  write?: (text: string) => void;
}

/**
 * Read ONE line of stdin in cooked mode; resolves "" on EOF. Mirrors the reader
 * `provider enable-metered` uses for its typed-consent gate.
 */
function readOneLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = "";
    const onData = (b: Buffer): void => {
      buf += b.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        stdin.off("data", onData);
        stdin.pause();
        resolve(buf.slice(0, nl + 1));
      }
    };
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", () => {
      stdin.off("data", onData);
      resolve(buf);
    });
  });
}

/**
 * The real typed-confirm for a bypass launch: print the prompt, require the phrase EXACTLY.
 *
 * Without this, `defaultRunLiveTerminal` handed `runLiveTerminal` no `confirm` seam, so it fell
 * back to its own `async () => false`. That is the correct fail-closed default for a missing
 * seam, but nothing ever supplied one in production — so a `--bypass` launch was refused
 * unconditionally with "bypass not confirmed" and there was no input that could approve it. The
 * gate was not strict; it was unreachable, and the feature could not be used at all.
 *
 * A non-TTY stdin still denies without prompting: a bridge or a pipe has no human to type the
 * phrase, and blocking on a read there would hang the caller instead of answering it.
 */
export async function ttyTypedConfirm(prompt: string, phrase: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  process.stdout.write(`${prompt}\n`);
  const line = await readOneLine();
  return line.replace(/\r?\n$/, "") === phrase;
}

/** Lazy default live-terminal seam (P5). Kept behind a thunk so a missing pty
 *  backend never breaks importing THIS module; the live-terminal module itself
 *  degrades from node-pty → child_process. */
async function defaultRunLiveTerminal(env: ChatTerminalEnvelope): Promise<number> {
  const mod = (await import("../pty/live-terminal.js")) as {
    runLiveTerminal: (
      env: ChatTerminalEnvelope,
      deps?: { confirm?: (prompt: string, phrase: string) => Promise<boolean> },
    ) => Promise<number>;
  };
  return mod.runLiveTerminal(env, { confirm: ttyTypedConfirm });
}

/** Lazy default tmux seam (P6). The tmux module owns TmuxSpec; we hand it the
 *  whole envelope (the engine's single source of truth) and let it assemble the
 *  injection-safe `has-session → new-session → attach` commands itself. */
async function defaultRunTmux(env: ChatTerminalEnvelope): Promise<number> {
  const mod = (await import("../tmux/tmux.js")) as {
    runTmuxFromEnvelope: (env: ChatTerminalEnvelope) => Promise<number>;
  };
  return mod.runTmuxFromEnvelope(env);
}

/* ------------------------------------------------------------------------- *
 * The handoff.
 * ------------------------------------------------------------------------- */

/**
 * Run the one-shot `chat --cli` flow. Returns:
 *   - a CommandOutcome when it PREVIEWS (no launch) — the caller renders it and
 *     exits with its code (0),
 *   - a number when it LAUNCHED (live terminal or tmux) — the child/tmux exit
 *     code, or a non-zero code on a declined/failed launch.
 *
 * Never throws: an engine/transport error is rendered friendly (CommandOutcome,
 * exit 2 fail-closed via outcomeFromError); a launch failure returns a non-zero
 * code with a friendly line. The session/CLI loop is never handed a raw stack.
 */
export async function runTerminalChat(
  opts: TerminalChatOpts,
  deps: TerminalChatDeps = {},
): Promise<CommandOutcome | number> {
  const write = deps.write ?? ((text: string) => process.stderr.write(`${text}\n`));

  // 1) PREVIEW — ask the engine for the assembled, injection-safe argv + env +
  //    notes. The engine runs no launch here (no `--open`); it only describes.
  let env: ChatTerminalEnvelope;
  try {
    const previewOpts: ChatPreviewOpts = toChatPreviewOpts(opts);
    env = await opts.client.runPrometheus<ChatTerminalEnvelope>(
      Commands.chatPreview(opts.cli, previewOpts),
    );
  } catch (err) {
    // A transport/engine failure is fail-closed (exit 2) — never a silent launch.
    return outcomeFromError(err);
  }

  // An engine-level failure rides through as ok:false — surface it, never launch.
  if (env.ok === false) {
    return {
      text: `prometheus chat --cli ${opts.cli}: ${env.error ?? "engine reported failure"}`,
      json: env,
      exitCode: 2,
    };
  }

  const wantsTmux = opts.tmux !== undefined && opts.tmux !== false;
  const wantsOpen = opts.open === true;

  // 2) DEFAULT — no launch switch → a read-only preview. The human inspects the
  //    notes + argv and re-runs with --open/--tmux to launch. Nothing spawns.
  if (!wantsOpen && !wantsTmux) {
    return previewOutcome(env);
  }

  // 3) LAUNCH — first surface the engine's notes VERBATIM (warnings about force,
  //    dry-run, missing bins, etc. — we render, we decide nothing, C5).
  for (const note of env.notes) write(note);

  // never-force: a bypass LAUNCH is held behind a typed-confirm BEFORE spawning.
  if (env.bypass) {
    const confirm = deps.confirm;
    if (!confirm) {
      // No confirmer wired (non-interactive) → DENY the override (fail-closed).
      write(
        `launch BLOCKED: '${env.label}' would run with permission-bypass, but no confirmation channel is available.`,
      );
      return 2;
    }
    const ok = await confirm(bypassConfirmPrompt(env), BYPASS_PHRASE);
    if (!ok) {
      write("bypass override declined — terminal not launched");
      return 2;
    }
  }

  // 4) SPAWN — hand the envelope to the chosen seam. tmux wins when both switches
  //    are set (mirrors the engine: `--tmux` takes the multiplexed path). Any
  //    failure inside the seam is caught → friendly line + non-zero code.
  try {
    if (wantsTmux) {
      const runTmux = deps.runTmux ?? defaultRunTmux;
      return await runTmux(env);
    }
    const runLive = deps.runLiveTerminal ?? defaultRunLiveTerminal;
    return await runLive(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    write(`launch failed: ${message}`);
    return 1;
  }
}
