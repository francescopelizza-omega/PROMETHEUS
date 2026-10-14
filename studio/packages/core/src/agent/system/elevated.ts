// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/elevated.ts — the shape of a privileged request (`propose_elevated`).
 *
 * The principle (2026-10): **Prometheus may run sudo, but never on its own authority.** Every
 * privileged command is shown to the human verbatim and runs only after that human approves
 * that exact command, every time. No authorization level, flag, setting, agent or tool can
 * pre-approve, remember or skip this approval.
 *
 * This module is the PURE half: it validates what the agent asked for and renders the text a
 * human reads. It still has no spawn seam. Execution lives in exactly one place,
 * `host/privileged-gate.ts`, which is reached only through `propose_elevated` and only runs
 * after a host-wired approver (TUI modal, Studio dialog, VS Code modal) says yes. A surface
 * with no human attached (MCP, `-p`/`--json`, CI) gets this module's proposal block back
 * instead — the same text the old copy-and-paste flow printed.
 *
 * `run_command` never runs a privileged command at all (`exec/classify.ts` rule 0): privileged
 * work has one path, so there is one place to review.
 *
 * ## The one genuinely dangerous thing this module does
 *
 * It emits a string destined for a **real shell** — the human's, by paste, when no human is
 * attached to approve it here. `shellQuote` is POSIX single-quoting, which has no escape
 * processing inside it at all, so `$(…)`, backticks, `\` and `|` are inert. Rendering with
 * double quotes would leave `$(…)` live, and the pasted command would do something the human
 * never read.
 *
 * Newlines are refused for the same reason at a coarser grain: a newline inside a "single"
 * proposed command is a second command the reviewer's eye skips.
 */

import { shellQuote } from "../exec/parse.js";

/** A proposal the human is asked to run themselves. Pure data — nothing here can execute. */
export interface ElevatedProposal {
  /** the command WITHOUT `sudo` — the prefix is ours to add, never the agent's to write. */
  argv: readonly string[];
  /** why elevation is needed, in the agent's words. Shown to the human verbatim. */
  why: string;
  /** where it should be run, for the human's benefit. */
  cwd?: string;
}

export type ElevatedCheck = { ok: true; proposal: ElevatedProposal } | { ok: false; error: string };

/**
 * Programs that make a proposal UNREVIEWABLE.
 *
 * The whole flow rests on a human reading the exact argv and deciding. `sh -c '…'` defeats
 * that: the reviewer sees a shell and an opaque string, and judging it means parsing the
 * inner text by eye — which is the job we just decided humans should not have to do under
 * time pressure. Same for the launcher family, which hides the real program one argument
 * deeper. Propose the inner command instead; that is a strictly better proposal anyway.
 *
 * Note what is NOT here: `shutdown`, `mkfs`, `dd`, `fdisk`. Those are refused for the AGENT
 * to run, and they are exactly the administrative work this flow exists to hand to a human.
 * Refusing to even print them would make the feature useless for its actual purpose.
 */
const UNREVIEWABLE = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "fish",
  "env",
  "nice",
  "nohup",
  "timeout",
  "setsid",
  "stdbuf",
  "script",
  "watch",
  "xargs",
  "eval",
  "exec",
]);

/** Elevation prefixes. The agent writing one of these is the case §7 exists to prevent. */
const ELEVATORS = new Set([
  "sudo",
  "doas",
  "su",
  "pkexec",
  "run0",
  "sudoedit",
  "machinectl",
  "runas",
  "gosu",
  "please",
]);

/** The program name without its directory — `/usr/bin/sudo` must not slip past `ELEVATORS`. */
function baseName(p: string): string {
  const cut = p.lastIndexOf("/");
  return cut === -1 ? p : p.slice(cut + 1);
}

/**
 * Validate a proposal. Refuses rather than sanitizes — the same discipline as the parser,
 * for the same reason: silently rewriting a command produces a string the human reviews and
 * a different string than the agent meant, and neither party can tell.
 */
export function checkElevated(
  argv: readonly unknown[],
  why: unknown,
  cwd?: unknown,
): ElevatedCheck {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, error: "propose_elevated: `argv` must be a non-empty array of strings" };
  }
  if (!argv.every((a): a is string => typeof a === "string")) {
    return { ok: false, error: "propose_elevated: every element of `argv` must be a string" };
  }
  const words = argv as string[];

  // A reason is mandatory. The human is being asked to take an irreversible action on their
  // own machine; "because the agent said so" is not a basis for that decision.
  if (typeof why !== "string" || why.trim().length < 8) {
    return {
      ok: false,
      error: "propose_elevated: `why` must explain, in a sentence, why elevation is required",
    };
  }

  const head = baseName(words[0] as string);
  if (ELEVATORS.has(head)) {
    return {
      ok: false,
      error: `propose_elevated: do not write \`${head}\` yourself — pass the command WITHOUT it and the elevation prefix is added when the proposal is rendered`,
    };
  }
  if (UNREVIEWABLE.has(head)) {
    return {
      ok: false,
      error: `propose_elevated: \`${head}\` hides the real command behind an argument, so the human cannot review what they would be running. Propose the inner command directly.`,
    };
  }

  for (const w of words) {
    // A newline turns one reviewed command into two pasted ones — the second below the fold,
    // where the eye that just approved the first one never reaches it.
    if (/[\n\r]/.test(w)) {
      return { ok: false, error: "propose_elevated: a newline in an argument is not allowed" };
    }
    // The rest of the control range would let a proposal repaint the terminal it is reviewed
    // in, so the block reads differently than the string it actually carries.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(w)) {
      return { ok: false, error: "propose_elevated: control characters in an argument" };
    }
  }
  if (typeof cwd === "string" && /[\n\r]/.test(cwd)) {
    return { ok: false, error: "propose_elevated: a newline in `cwd` is not allowed" };
  }

  return {
    ok: true,
    proposal: {
      argv: words,
      why: why.trim(),
      ...(typeof cwd === "string" && cwd ? { cwd } : {}),
    },
  };
}

/**
 * The exact line the human copies.
 *
 * Every word is POSIX-single-quoted unless it is plainly safe, so what the human reads is
 * what their shell will run. This is the string that matters; everything else in the rendered
 * block is context around it.
 */
export function elevatedCommandLine(p: ElevatedProposal, elevator = "sudo"): string {
  return `${elevator} ${p.argv.map(shellQuote).join(" ")}`;
}

/**
 * Render the block shown to the human.
 *
 * Deliberately plain text: this goes to a terminal, a GUI panel and an audit line, and the
 * one thing all three must agree on is the command itself.
 */
export function renderElevated(
  p: ElevatedProposal,
  extra?: { verdict?: string },
  elevator = "sudo",
): string {
  const lines = [
    "PRIVILEGED COMMAND — needs a human. Nobody here can approve it, so Prometheus has NOT run it.",
    "",
    `  ${elevatedCommandLine(p, elevator)}`,
    "",
    `why: ${p.why}`,
  ];
  if (p.cwd) lines.push(`run in: ${p.cwd}`);
  if (extra?.verdict) lines.push(`nemesis: ${extra.verdict}`);
  lines.push(
    "",
    "Ask for it in a Prometheus window (TUI, Studio or VS Code), which shows you this exact",
    "command and runs it only if you approve — or copy it into your own terminal. Prometheus",
    "never stores, caches or forwards an elevation password.",
  );
  return lines.join("\n");
}
