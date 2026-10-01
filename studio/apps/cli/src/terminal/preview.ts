// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * terminal/preview.ts — the PURE builders behind the `chat --cli` handoff (P5).
 *
 * Everything here is deterministic string/shape work with NO I/O, NO spawning,
 * and NO engine call — so it unit-tests in isolation (preview.test.ts) and the
 * spawning module (engine-handoff.ts) keeps only the control flow + injected
 * seams. Three jobs:
 *   - `toChatPreviewOpts`   map the CLI-facing TerminalChatOpts → the engine
 *                           builder's ChatPreviewOpts (drops the launch-only +
 *                           transport fields the engine preview must NOT see).
 *   - `previewOutcome`      render a read-only PREVIEW CommandOutcome from the
 *                           engine's ChatTerminalEnvelope: the label, the notes
 *                           VERBATIM, and the exact argv that OPEN would run.
 *   - `bypassConfirmPrompt` build the never-force typed-confirm prompt (the
 *                           human must type BYPASS_PHRASE to launch a bypass).
 *
 * Color goes ONLY through render.ts (sources the ui tokens / ANSI map). The argv
 * is rendered for HUMAN READING with a shell-style quote — this is display only;
 * the engine already returned the injection-safe argv that the spawner execs as
 * discrete tokens (we NEVER re-parse this rendered string back into argv, C5).
 */
import type { ChatPreviewOpts, ChatTerminalEnvelope } from "@prometheus/engine-bridge";

import type { CommandOutcome } from "../context.js";
import { c } from "../render.js";

/** The exact phrase the human types to launch a permission-bypass terminal. */
export const BYPASS_PHRASE = "BYPASS";

/**
 * The CLI-facing options the handoff accepts. Re-declared structurally (NOT
 * imported from engine-handoff.ts) to keep this pure module free of the launch
 * surface — only the fields that lower into ChatPreviewOpts matter here.
 */
export interface ChatPreviewInput {
  model?: string;
  systemPrompt?: string;
  replaceSystem?: boolean;
  bypass?: boolean;
  /** true = --tmux (default session); string = --tmux NAME; omit/false = none. */
  tmux?: string | boolean;
  cwd?: string;
  prompt?: string;
}

/**
 * Lower the CLI opts to the engine builder's ChatPreviewOpts. Only the fields
 * the engine's `chat --cli` PREVIEW understands are forwarded; the launch-only
 * switches (`open`) and transport (`client`/`json`) never reach the builder.
 *
 * `tmux:false` is normalised to "omit" (the builder treats a present `false` and
 * an absent value the same, but dropping it keeps the previewed argv minimal).
 */
export function toChatPreviewOpts(input: ChatPreviewInput): ChatPreviewOpts {
  const opts: ChatPreviewOpts = {};
  if (input.model) opts.model = input.model;
  if (input.systemPrompt) opts.systemPrompt = input.systemPrompt;
  if (input.replaceSystem) opts.replaceSystem = true;
  if (input.bypass) opts.bypass = true;
  if (input.tmux !== undefined && input.tmux !== false) opts.tmux = input.tmux;
  if (input.cwd) opts.cwd = input.cwd;
  if (input.prompt) opts.prompt = input.prompt;
  return opts;
}

/**
 * Render a read-only PREVIEW CommandOutcome from the engine's terminal envelope.
 * Shows the service label + interactivity, the engine's notes VERBATIM (warnings
 * we surface but never act on — C5), every env override, the resolved cwd, and
 * the exact argv. The closing hint tells the human how to actually launch.
 *
 * The machine payload is the envelope itself (so `--json` emits the contract the
 * GUI/scripts consume). Exit 0: a preview is a successful no-op, never a launch.
 */
export function previewOutcome(env: ChatTerminalEnvelope): CommandOutcome {
  const lines: string[] = [];

  const mode = env.interactive ? "interactive" : "one-shot";
  lines.push(`${c.bold(env.label)} ${c.dim(`(${env.cli} · ${mode})`)}`);
  if (env.model) lines.push(kvLine("model", env.model));
  lines.push(kvLine("cwd", env.cwd));
  if (env.tmux) lines.push(kvLine("tmux", env.tmux));

  // Engine notes — verbatim. A bypass preview is flagged so the human sees the
  // permission-override BEFORE they re-run with --open (which then type-confirms).
  if (env.bypass) {
    lines.push(c.yellow("⚠ permission-bypass: launching will require typed confirmation"));
  }
  for (const note of env.notes) lines.push(c.dim(`• ${note}`));

  // Env overrides (e.g. GEMINI_SYSTEM_MD) the launch will set — display only.
  const envKeys = Object.keys(env.env);
  if (envKeys.length > 0) {
    lines.push(c.dim("env:"));
    for (const k of envKeys.sort()) lines.push(`  ${c.dim(`${k}=`)}${env.env[k] ?? ""}`);
  }

  // The exact argv OPEN would run — for HUMAN reading only (shell-style quoting),
  // never re-parsed into argv. The engine already validated it injection-safe.
  lines.push(c.dim("would run:"));
  lines.push(`  ${c.cyan(renderArgv(env.argv))}`);

  lines.push("");
  lines.push(c.dim("preview only — add --open to launch, or --tmux to multiplex"));

  return { text: lines.join("\n"), json: env, exitCode: 0 };
}

/**
 * The never-force typed-confirm prompt for a bypass LAUNCH. Tells the human the
 * concrete risk (permission-bypass on this CLI) and the exact phrase to type. We
 * decide nothing — the engine already set `bypass`; we only require acknowledgement.
 */
export function bypassConfirmPrompt(env: ChatTerminalEnvelope): string {
  return [
    `'${env.label}' will launch with PERMISSION-BYPASS (--bypass / skip-permissions).`,
    "This overrides the CLI's own approval prompts. The engine flagged it, not you.",
    `Type ${BYPASS_PHRASE} to launch, anything else to cancel`,
  ].join("\n");
}

/* ------------------------------------------------------------------------- *
 * Tiny render helpers (display-only; color via render.ts).
 * ------------------------------------------------------------------------- */

/** A dim-key `key: value` line (matches render.kv but local to keep deps tight). */
function kvLine(key: string, value: string): string {
  return `${c.dim(`${key}:`)} ${value}`;
}

/**
 * Render an argv as a single shell-style line for HUMAN reading. A token that
 * contains whitespace, a quote, or a shell metacharacter is single-quoted (with
 * embedded single-quotes escaped the POSIX way: '\'' ). This is DISPLAY ONLY —
 * the spawner uses env.argv directly as discrete tokens, never this string.
 */
export function renderArgv(argv: readonly string[]): string {
  return argv.map(quoteForDisplay).join(" ");
}

const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

function quoteForDisplay(token: string): string {
  if (token.length > 0 && SAFE_TOKEN.test(token)) return token;
  // POSIX single-quote escaping: close, emit an escaped quote, reopen.
  return `'${token.replace(/'/g, "'\\''")}'`;
}
