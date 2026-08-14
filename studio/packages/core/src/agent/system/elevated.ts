/**
 * agent/system/elevated.ts — the elevated-proposal flow (full_wrapper_compose §7 / Phase 5).
 *
 * The brief asked for *"eventual sudo use of manually user's authorised commands"*. This is
 * the answer, and the answer is deliberately unsatisfying: **the agent never runs sudo.**
 *
 * `sudo` in an agent-composed argv is a refusal at the parser, not a confirm. The reasoning
 * is about the failure mode rather than the happy path — a dialog reading *"run `sudo rm -rf
 * /var`?"* is one mis-click from an unrecoverable machine, and prompt injection makes
 * mis-clicks cheap to manufacture at scale. A yes/no button is the wrong instrument when the
 * cost of the wrong answer is that high.
 *
 * So the agent gets a way to ASK, not a way to DO: `propose_elevated({argv, why})` renders a
 * block the human reads and copies into their own shell, under their own TTY, answering their
 * own sudo prompt. Nothing in this module executes anything — there is no spawn seam here at
 * all, which is the property worth checking when reviewing it.
 *
 * ## The one genuinely dangerous thing this module does
 *
 * It emits a string destined for a **real shell** — the human's, by paste. Everywhere else in
 * the exec stack we avoid shell syntax precisely so quoting can never bite; here it is the
 * deliverable, so quoting is load-bearing. `shellQuote` is POSIX single-quoting, which has no
 * escape processing inside it at all, so `$(…)`, backticks, `\` and `|` are inert. Rendering
 * with double quotes — as a nearby display helper does — would leave `$(…)` live, and the
 * pasted command would do something the human never read.
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
const ELEVATORS = new Set(["sudo", "doas", "su", "pkexec", "runas", "gosu", "please"]);

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
export function elevatedCommandLine(p: ElevatedProposal): string {
  return `sudo ${p.argv.map(shellQuote).join(" ")}`;
}

/**
 * Render the block shown to the human.
 *
 * Deliberately plain text: this goes to a terminal, a GUI panel and an audit line, and the
 * one thing all three must agree on is the command itself.
 */
export function renderElevated(p: ElevatedProposal, extra?: { verdict?: string }): string {
  const lines = [
    "ELEVATED COMMAND PROPOSAL — Prometheus will NOT run this.",
    "",
    `  ${elevatedCommandLine(p)}`,
    "",
    `why: ${p.why}`,
  ];
  if (p.cwd) lines.push(`run in: ${p.cwd}`);
  if (extra?.verdict) lines.push(`nemesis: ${extra.verdict}`);
  lines.push(
    "",
    "Copy it and run it yourself, so the sudo prompt is answered by you in your own",
    "terminal. Prometheus never stores, caches or forwards an elevation password.",
  );
  return lines.join("\n");
}
