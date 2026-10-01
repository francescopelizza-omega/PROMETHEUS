// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/remedies.ts — turn a diagnosed conflict into a repair that can actually be RUN.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * `conflicts.ts` ends one step short of useful. It says, correctly:
 *
 *     claude is installed 2 times: vendor installer 2.1.284 (on PATH), Homebrew cask 2.1.274.
 *     Each owner will keep offering its own updates, and only the one on PATH has any effect.
 *     Update notices for the others will never clear.
 *
 * Every word of that is true, and it leaves the user holding a problem instead of a solution.
 * "Update notices for the others will never clear" is a *prediction of permanent nagging* with
 * no way out attached. The user's report was exactly that: the same conflicts, every run,
 * forever, with nothing to do about them.
 *
 * The repair is usually ONE command. It is just never the command the user would guess, and
 * several of the plausible guesses are actively destructive. This module holds the ones that
 * are correct, keyed to the situation that makes them correct.
 *
 * ── WHY THE REPAIR IS NOT "UPGRADE" ─────────────────────────────────────────────────────────
 *
 * Every conflict here has the same root: **the same tool is installed more than once.** An
 * upgrade cannot fix that — it is what keeps re-creating it. The repair is to make the machine
 * have ONE of the thing, owned by ONE manager, and the conflict then stops being reported
 * because it stops being true. That is what `permanent` marks.
 *
 * ── WHY IT IS `argv` AND NEVER A SHELL STRING ───────────────────────────────────────────────
 *
 * Every step is an argv array, executed without a shell. A tool name, a cask token or a path
 * reaches this module from the FILESYSTEM — a realpath, a directory listing, an npm prefix — and
 * a repair built by pasting those into a string is a command-injection surface inside the
 * feature whose entire job is auditing what gets run. The renderer joins argv for display; the
 * executor never does.
 *
 * ── AND WHY SOME REPAIRS REFUSE ─────────────────────────────────────────────────────────────
 *
 * A remedy with `blocked` set is one this module KNOWS and will not run, because the obvious
 * repair is wrong in a way the user cannot see. Those are the most valuable rows in the file:
 * `brew uninstall --zap --cask claude-code` looks like the thorough version of the correct
 * command and deletes the config of the install you are keeping.
 *
 * PURE. Conflicts and measured facts in, plans out. No spawn, no fs, no network.
 */

import type { Conflict, ConflictKind } from "./conflicts.js";
import { type ToolCopy, type ToolResolution, ownerLabel, zapHazard } from "./install-owner.js";
/**
 * The authorisation ladder is imported, never redeclared.
 *
 * `model-actions.ts` already fixed these rungs against `agent/authorization.ts`'s ordering
 * (read < write < config < command < install < destructive). A second copy of the numbers here
 * would be two sources of truth for "how dangerous is this", and they would drift the first
 * time one of them was tuned.
 */
import { AUTH_CONFIG, AUTH_DESTRUCTIVE } from "./model-actions.js";

/* ──────────────────────────────── the shapes ──────────────────────────────── */

/**
 * How much a step can cost if it is the wrong one.
 *
 * Not a severity — severity describes the PROBLEM. This describes the REPAIR, and the two move
 * in opposite directions: the highest-severity conflicts here have the safest fixes, because
 * removing a duplicate copy of a tool is undone by installing it again.
 */
export type RemedyRisk =
  /** changes nothing that is not trivially re-creatable. */
  | "reversible"
  /** removes one install of a tool that is installed more than once. Re-installable. */
  | "removes-a-copy"
  /** appends to a shell init file. Cheap to undo, expensive to get wrong — see `EDIT_GUARD`. */
  | "edits-shell-init"
  /** cannot be undone from here. Never run without an explicit confirmation. */
  | "irreversible";

/** One executable step of a repair. */
export interface RemedyStep {
  /**
   * The exact argv. Never joined, never passed to a shell, never interpolated into one.
   * `argv[0]` is the program; the rest are arguments exactly as the child should receive them.
   */
  argv: readonly string[];
  /** what this step does, in one line, in the user's terms. */
  purpose: string;
  risk: RemedyRisk;
  /** the command that undoes it, when there is one. Absent means it cannot be undone. */
  undo?: readonly string[];
  /**
   * A human-readable stand-in for `argv`, when the argv is correct and unreadable.
   *
   * Only one case needs it, and it needs it badly: appending a multi-line block to a shell init
   * file. The argv is right — the block arrives as a single `$1` ARGUMENT so a path containing a
   * quote or a `$` cannot become code — but rendered as a command line it is a wall of escaped
   * newlines that nobody can check. A repair the user cannot read is a repair they should not
   * run, so the display shows the block and the destination, and the executor still uses `argv`.
   */
  displayAs?: readonly string[];
}

export interface Remedy {
  /** the conflict this repairs. */
  kind: ConflictKind;
  /** the tool or manager the user would recognise — matches `Conflict.subject`. */
  subject: string;
  /** one line naming the repair. */
  title: string;
  /**
   * WHY this is the right repair and not merely a repair. Rendered above the commands, because a
   * repair the user does not understand is one they will not run — and should not.
   */
  rationale: string;
  steps: readonly RemedyStep[];
  /**
   * The command that PROVES it worked, run after the steps.
   *
   * Not decoration. Every conflict in this module comes from a command that reports success
   * while changing nothing, so a repair that is trusted because it exited 0 has reproduced the
   * original defect one level up.
   */
  verify?: readonly string[];
  /** what this deliberately does NOT touch, so the user is not surprised by what survives. */
  keeps?: string;
  /** the authorisation rung on the 0–7 ladder — see `model-actions.ts`. */
  minAuthLevel: number;
  /**
   * Set when this repair must NOT be offered as executable. The text says why, and is shown
   * INSTEAD of the steps. A blocked remedy is still worth emitting: it is how the user learns
   * that the obvious command is a trap before they find it somewhere else.
   */
  blocked?: string;
  /**
   * True when running this makes the conflict stop being REPORTED, because it stops being true.
   *
   * The distinction the user cares about most. A repair that silences one run and leaves the
   * duplicate in place is why "update notices for the others will never clear".
   */
  permanent: boolean;
}

/* ─────────────────────── the hardcoded hazard knowledge ─────────────────────── */

/**
 * Casks whose `zap` stanza deletes state belonging to a DIFFERENT install of the same tool.
 *
 * This is the table that makes `--zap` safe to talk about. `brew uninstall --cask X` removes the
 * cask's own artifacts and its Caskroom directory; `--zap` additionally deletes everything the
 * cask's zap stanza lists — which for a tool that also ships a vendor installer routinely
 * includes the vendor install's data directory and the user's config, i.e. the copy they are
 * KEEPING.
 *
 * Paths use `~` literally; the caller expands against the real home before comparing. Keeping
 * them unexpanded means this table stays a pure constant and one machine's home cannot leak
 * into it.
 */
export const CASK_ZAP_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  /**
   * Read VERBATIM from `~/Library/Caches/Homebrew/api/cask/claude-code.json` on 2026-09-30:
   *
   *   "zap": { "trash": ["~/.cache/claude", "~/.claude.json*", "~/.config/claude",
   *                      "~/.local/bin/claude", "~/.local/share/claude",
   *                      "~/.local/state/claude", "~/Library/Caches/claude-cli-nodejs"],
   *            "rmdir": "~/.claude" }
   *
   * FOUR of those seven are the VENDOR install, not the cask: `~/.local/bin/claude` is the
   * PATH-winning symlink, `~/.local/share/claude` holds all five retained builds (1.2 GB,
   * including the 2.1.284 that actually runs), and `~/.claude.json*` is the user's config.
   * So zapping the stale 2.1.274 cask deletes the newer install you are keeping and its
   * settings — from the command that sounds like the thorough one.
   *
   * `rmdir: ~/.claude` is the only benign entry, and only by accident: Homebrew's
   * `recursive_rmdir` bails unless every child is a directory, and `~/.claude` holds plain
   * files. Do not rely on that.
   */
  "claude-code": Object.freeze([
    "~/.cache/claude",
    "~/.claude.json",
    "~/.config/claude",
    "~/.local/bin/claude",
    "~/.local/share/claude",
    "~/.local/state/claude",
    "~/Library/Caches/claude-cli-nodejs",
    "~/.claude",
  ]),
  codex: Object.freeze(["~/.codex", "~/.local/share/codex"]),
  /** A zap here takes `~/.ollama` — every downloaded model, tens of GB. Never offered. */
  ollama: Object.freeze(["~/.ollama"]),
  "ollama-app": Object.freeze(["~/.ollama"]),
  "lm-studio": Object.freeze(["~/.lmstudio", "~/.cache/lm-studio"]),
});

/**
 * Tools this feature will never propose removing a copy of, whatever the conflict says.
 *
 * Each is load-bearing for something other than itself, so "tidy up the duplicate" is a trade the
 * user did not make:
 *
 *   • `rg` — CLAUDE.md §3: "a hard prerequisite. The `glob` host tool shells out to it", and
 *     `system-tools.test.ts` fails without it.
 *   • `node`, `pnpm` — `engineStrict: true` with `engines.node >= 22.6`, so removing the wrong
 *     one turns `pnpm install` into a hard error, and a `node-pty` addon is built against one
 *     specific ABI.
 *   • `git` — the PATH copy here is the OS one; macOS updates it and deleting it breaks more
 *     than this tool.
 *   • `ollama` — §2.8, in full. Two ollamas contending for :11434 crash-looped 36,135 times.
 */
export const NEVER_REMOVE: readonly string[] = Object.freeze([
  "rg",
  "ripgrep",
  "node",
  "pnpm",
  "git",
  "ollama",
]);

/**
 * Commands this module will never emit, with the measured reason.
 *
 * Kept as DATA rather than as an `if` inside whatever function nearly produced one, so a new
 * remedy has to walk past the list to reinvent a known-bad command. Each entry is something that
 * was either offered by a package manager, printed in a changelog, or is the obvious guess.
 */
export const NEVER_RUN: readonly { argv: readonly string[]; because: string }[] = Object.freeze([
  Object.freeze({
    argv: Object.freeze(["brew", "uninstall", "--zap", "--cask", "claude-code"]),
    because:
      "the zap stanza trashes ~/.local/bin/claude, ~/.local/share/claude (1.2 GB, all five builds including the one you run) and ~/.claude.json* — the vendor install you are KEEPING, plus your config. `brew uninstall --cask claude-code` removes the redundant copy and nothing else. Note there is no preview: `brew uninstall` has no --dry-run (measured: `Error: invalid option: --dry-run`).",
  }),
  Object.freeze({
    argv: Object.freeze(["brew", "upgrade", "--cask", "ollama-app"]),
    because:
      "installs a cask over a pre-existing /Applications bundle. Two ollamas fighting for :11434 crash-looped 36,135 times on this machine (CLAUDE.md §2.8).",
  }),
  Object.freeze({
    argv: Object.freeze(["brew", "services", "start", "ollama"]),
    because:
      "the brew service is stopped on purpose — it fought Ollama.app for :11434. Start one or the other, never both (CLAUDE.md §2.8).",
  }),
  Object.freeze({
    argv: Object.freeze(["brew", "autoremove"]),
    because:
      "after removing a formula this sweeps its now-orphaned dependencies. Measured for ollama those are ca-certificates, lz4, mlx, mlx-c, mpdecimal, python@3.14, readline, sqlite, xz and zstd — `brew uses --installed ollama` being empty says nothing about what depends on THOSE.",
  }),
  Object.freeze({
    argv: Object.freeze(["codex", "update"]),
    because:
      "measured: this rewrites ~/.npmrc to a new global prefix and installs a vendor copy at ~/.local/bin/codex, permanently shadowing the Homebrew cask. It MANUFACTURES the duplicate install rather than resolving one.",
  }),
  Object.freeze({
    argv: Object.freeze(["npm", "config", "set", "prefix"]),
    because:
      "every global already installed under the old prefix becomes invisible the instant this lands — `npm ls -g` stops listing it, `npm uninstall -g` stops finding it, and the files stay on disk unreferenced forever. Uninstall the old globals FIRST, or extend PATH instead.",
  }),
]);

/** True when `argv` is one of the known-bad commands. Exact match — never a substring test. */
export function isNeverRun(argv: readonly string[]): boolean {
  return NEVER_RUN.some(
    (n) => n.argv.length === argv.length && n.argv.every((a, i) => a === argv[i]),
  );
}

/**
 * The guarantees a shell-init edit must satisfy before it may be executed.
 *
 * Stated as a constant because the danger is not the content of the line — it is that a broken
 * `.zshrc` greets the user with a non-functioning shell on every future login, on a machine
 * whose recovery path is "open a terminal". An append that is not idempotent also compounds:
 * run the repair twice and PATH grows twice.
 */
export const EDIT_GUARD = Object.freeze({
  /** never write a line the file already contains. */
  idempotent: true,
  /** copy the file beside itself before touching it. */
  backupSuffix: ".prometheus.bak",
  /** append only. Never rewrite, reorder or delete an existing line. */
  appendOnly: true,
});

/* ─────────────────────────── the facts a repair needs ─────────────────────────── */

export interface RemedyContext {
  /** the resolution for the conflict's subject, when it is a tool. */
  resolution?: ToolResolution;
  /** the user's home, for expanding the `~` in `CASK_ZAP_PATHS`. */
  home?: string;
  /**
   * The shell init file a PATH repair should append to, already chosen by the caller.
   *
   * Chosen there and not here because the right answer is a filesystem question — which files
   * exist, which one the login shell actually reads — and this module does no IO. Absent means
   * the PATH repair is emitted as instructions rather than as a runnable step.
   */
  shellInit?: { path: string; line: string; alreadyPresent: boolean };
  /** the manager bin directory a `unreachable-bin-dir` conflict is about. */
  binDir?: string;
}

/** Expand a leading `~` against a known home. Returns the input unchanged when home is absent. */
function expand(p: string, home?: string): string {
  return home && p.startsWith("~/") ? `${home}/${p.slice(2)}` : p;
}

/**
 * The copy to REMOVE for a duplicate/shadowing conflict: the one that is not on PATH.
 *
 * Deliberately the loser, always. Removing the winner would change which binary the user's
 * shell resolves — a far larger act than the conflict warrants, and one that breaks the tool
 * until the other copy is found. The loser is by definition the copy nothing currently runs.
 */
function loser(res: ToolResolution | undefined): ToolCopy | undefined {
  if (!res?.winner) return undefined;
  return res.copies.find((c) => c !== res.winner);
}

/**
 * The uninstall step for a copy, chosen by who owns it.
 *
 * Returns `null` for an owner with no safe scripted removal — a `system` binary (macOS updates
 * it, and deleting it breaks the OS), an `app-bundle` (dragging an app to the Trash is not a
 * job for a background process), and `unknown` (removing a file we could not attribute is
 * exactly the operation that should require a human).
 */
function removalStep(copy: ToolCopy): RemedyStep | null {
  const name = copy.name ?? "";
  switch (copy.owner) {
    case "brew-cask":
      if (!name) return null;
      return {
        argv: ["brew", "uninstall", "--cask", name],
        purpose: `remove the Homebrew cask copy at ${copy.realPath}`,
        risk: "removes-a-copy",
        undo: ["brew", "install", "--cask", name],
      };
    case "brew-formula":
      if (!name) return null;
      return {
        argv: ["brew", "uninstall", name],
        purpose: `remove the Homebrew formula copy at ${copy.realPath}`,
        risk: "removes-a-copy",
        undo: ["brew", "install", name],
      };
    case "npm-global":
      if (!name) return null;
      return {
        argv: ["npm", "uninstall", "-g", name],
        purpose: `remove the npm global copy of ${name}`,
        risk: "removes-a-copy",
        undo: ["npm", "install", "-g", name],
      };
    case "pnpm-global":
      if (!name) return null;
      return {
        argv: ["pnpm", "remove", "-g", name],
        purpose: `remove the pnpm global copy of ${name}`,
        risk: "removes-a-copy",
        undo: ["pnpm", "add", "-g", name],
      };
    case "pipx":
      if (!name) return null;
      return {
        argv: ["pipx", "uninstall", name],
        purpose: `remove the pipx copy of ${name}`,
        risk: "removes-a-copy",
        undo: ["pipx", "install", name],
      };
    default:
      // native-installer, app-bundle, system, python-venv, cargo, go, unknown.
      // Each of these either has no uninstall verb, or removing it means deleting files we
      // attributed by inference. Neither belongs in a scripted repair.
      return null;
  }
}

/**
 * Why a copy cannot be removed by a script, phrased for the user.
 *
 * Separate from `removalStep` returning `null` because "there is no step" and "here is why
 * there is no step" are different products, and only the second is useful.
 */
function whyNotRemovable(copy: ToolCopy): string {
  switch (copy.owner) {
    case "native-installer":
      return `the ${ownerLabel(copy.owner)} copy at ${copy.realPath} has no uninstall command — its installer owns a versions/ tree. Remove that directory by hand if you want it gone, after confirming which copy you want to keep.`;
    case "app-bundle":
      return `this copy belongs to an application bundle (${copy.realPath}). Removing an app is a decision for the Finder, not for a background process — and the app, not the CLI, owns the server.`;
    case "system":
      return `this copy ships with the OS (${copy.realPath}). macOS updates it, and deleting it breaks things that are not this tool.`;
    default:
      return `this copy could not be attributed to any package manager (${copy.realPath}), so there is no removal command that is known to be correct. Removing a file we cannot attribute is the one case that should always be a human's call.`;
  }
}

/* ────────────────────────────── the repairs ────────────────────────────── */

/**
 * The repair for one conflict, or `null` when none is known.
 *
 * `null` is a real answer and not a failure: some conflicts are facts about the machine that no
 * command resolves, and inventing a plausible one would be worse than saying nothing.
 */
export function remedyFor(conflict: Conflict, ctx: RemedyContext = {}): Remedy | null {
  switch (conflict.kind) {
    case "downgrade-offer":
    case "shadowed-upgrade":
    case "duplicate-install":
      return deduplicate(conflict, ctx);
    case "shadowed-newer":
      return preferNewer(conflict, ctx);
    case "unreachable-bin-dir":
      return reachBinDir(conflict, ctx);
    case "client-server-skew":
      return skew(conflict, ctx);
    default:
      return null;
  }
}

/**
 * The repair for every flavour of "installed twice": remove the copy that is not on PATH.
 *
 * One function for three conflict kinds because they are one situation seen from three angles —
 * a manager offering an upgrade for the shadow, a manager offering an OLDER version for the
 * shadow, and the plain fact of the duplicate. The repair does not differ, and splitting it
 * would have let the three drift.
 */
function deduplicate(conflict: Conflict, ctx: RemedyContext): Remedy | null {
  const res = ctx.resolution;
  const dead = loser(res);
  if (!res?.winner || !dead) return null;
  const keep = res.winner;

  /**
   * The never-remove list wins over every other consideration.
   *
   * These tools are load-bearing for something OTHER than themselves, so "tidy up the duplicate"
   * is a trade the user did not agree to. The finding is still emitted — it is true — but with
   * the repair withheld and the reason stated, which is strictly more useful than a repair that
   * breaks `pnpm install` or the `glob` host tool.
   */
  if (NEVER_REMOVE.includes(conflict.subject)) {
    return {
      kind: conflict.kind,
      subject: conflict.subject,
      title: `${conflict.subject} is installed twice — resolve this by hand`,
      rationale: `You run the ${ownerLabel(keep.owner)} copy at ${keep.pathEntry}; the ${ownerLabel(dead.owner)} copy at ${dead.realPath} is never reached and its owner will keep offering updates for it.`,
      steps: [],
      blocked: `${conflict.subject} is on the never-remove list: other things depend on it, so removing a copy is a decision with consequences beyond this tool. ${conflict.subject === "ollama" ? "Two ollamas contending for :11434 crash-looped 36,135 times here (CLAUDE.md §2.8)." : conflict.subject === "rg" || conflict.subject === "ripgrep" ? "ripgrep is a hard prerequisite — the `glob` host tool shells out to it (CLAUDE.md §3)." : "`engineStrict: true` and a native addon built against one ABI mean the wrong removal turns `pnpm install` into a hard error."} Decide which copy you want and remove it yourself.`,
      minAuthLevel: AUTH_DESTRUCTIVE,
      permanent: false,
    };
  }

  const step = removalStep(dead);
  const zapTable = dead.name ? (CASK_ZAP_PATHS[dead.name] ?? []) : [];
  /**
   * The check that makes `--zap` discussable, and the first production caller `zapHazard` has
   * ever had. It was written for exactly this decision, exported, and then reached by nothing —
   * so the knowledge that a zap can destroy the OTHER install existed only as prose in a note.
   */
  const casualties = zapHazard(
    zapTable.map((p) => expand(p, ctx.home)),
    res.copies,
    dead,
  );

  const zapWarning =
    zapTable.length > 0
      ? ` Do NOT add \`--zap\`: its stanza deletes ${zapTable.join(", ")}${
          casualties.length > 0
            ? ` — which is where the ${ownerLabel(keep.owner)} copy you are KEEPING lives`
            : ", i.e. your configuration for the copy you are keeping"
        }.`
      : "";

  if (!step) {
    return {
      kind: conflict.kind,
      subject: conflict.subject,
      title: `Remove the duplicate ${conflict.subject}`,
      rationale: `${conflict.subject} is installed twice and only the ${ownerLabel(keep.owner)} copy at ${keep.pathEntry} is ever run. ${whyNotRemovable(dead)}`,
      steps: [],
      blocked: whyNotRemovable(dead),
      minAuthLevel: AUTH_DESTRUCTIVE,
      permanent: false,
    };
  }

  return {
    kind: conflict.kind,
    subject: conflict.subject,
    title: `Remove the ${ownerLabel(dead.owner)} copy of ${conflict.subject}`,
    rationale:
      `You run the ${ownerLabel(keep.owner)} copy${keep.version ? ` (${keep.version})` : ""} at ${keep.pathEntry}. The ${ownerLabel(dead.owner)} copy${dead.version ? ` (${dead.version})` : ""} at ${dead.realPath} is never reached, and its owner will keep offering updates for it forever — which is why this notice never clears. ` +
      `Removing it does not change the ${conflict.subject} you run; it stops a second owner claiming the name.${zapWarning}`,
    steps: [step],
    verify: ["command", "-v", conflict.subject],
    keeps: `the ${ownerLabel(keep.owner)} copy at ${keep.pathEntry}, and all of your ${conflict.subject} configuration.`,
    minAuthLevel: AUTH_DESTRUCTIVE,
    permanent: true,
  };
}

/**
 * A NEWER copy is installed and PATH reaches the older one.
 *
 * Deliberately NOT auto-repaired by removing the winner. Two reasons, and both are the kind that
 * only show up afterwards: the PATH order is usually set by a line in a shell init file, so
 * removing the binary treats a symptom that will recur on the next install; and the winner may
 * be the copy an unrelated tool depends on. The repair is a PATH ordering change, which is the
 * user's to make — so this emits the fact, the two options and no executable step.
 */
function preferNewer(conflict: Conflict, ctx: RemedyContext): Remedy | null {
  const res = ctx.resolution;
  const newer = res?.newerShadow;
  if (!res?.winner || !newer) return null;
  const winner = res.winner;
  const newerDir = newer.pathEntry.replace(/\/[^/]+$/, "");
  const winnerDir = winner.pathEntry.replace(/\/[^/]+$/, "");

  return {
    kind: conflict.kind,
    subject: conflict.subject,
    title: `Reach the ${newer.version ?? "newer"} copy of ${conflict.subject} that is already installed`,
    rationale: `Both copies are on disk. ${newer.version ?? "The newer one"} sits at ${newer.realPath} and ${winner.version ?? "the older one"} at ${winner.realPath}, and PATH finds the second one first. No update will change this — the bits you want are already here and are simply never reached. Either put ${newerDir} ahead of ${winnerDir} on PATH, or remove the copy you do not want.`,
    steps: [],
    /**
     * Blocked, not "unsupported". Editing PATH ORDER is a different act from appending a missing
     * directory: it silently changes which binary every command in every future shell resolves
     * to, including tools that are not this one.
     */
    blocked: `Prometheus will not reorder your PATH for you — that changes which binary every future shell resolves, for every tool, not only ${conflict.subject}. Move ${newerDir} ahead of ${winnerDir} in your shell init yourself, or run \`/updates fix ${conflict.subject} --remove-older\` to delete the ${ownerLabel(winner.owner)} copy instead.`,
    verify: ["command", "-v", conflict.subject],
    minAuthLevel: AUTH_CONFIG,
    permanent: false,
  };
}

/**
 * A manager's bin directory is not on PATH, so everything it installs is unrunnable.
 *
 * The one conflict here that is not about duplicates, and the one with a genuinely executable
 * repair — appending a line to a shell init file. Two routes exist and the choice is not a
 * toss-up:
 *
 *   (a) ADD the directory to PATH. Everything already installed there becomes reachable at once.
 *   (b) RE-POINT the manager's prefix at a directory already on PATH (`npm config set prefix`).
 *       Everything already installed under the old prefix becomes invisible — they are not
 *       moved, and `npm ls -g` will no longer list them. On this machine that is not
 *       hypothetical: `codex update` rewrote the prefix, which is how the directory came to be
 *       unreachable in the first place.
 *
 * So (a) is the repair and (b) is named as an alternative with its cost stated, rather than
 * silently chosen because it is one command.
 */
function reachBinDir(conflict: Conflict, ctx: RemedyContext): Remedy | null {
  const dir = ctx.binDir;
  if (!dir) return null;
  const init = ctx.shellInit;

  const rationale =
    `${conflict.subject} installs executables into ${dir}, and no shell searches there. Anything installed through it exits 0 and leaves a launcher nothing will ever find — which is indistinguishable, from the outside, from "the update did nothing". Adding the directory to PATH also makes everything already installed there reachable, which re-pointing the prefix would not: those packages are not moved, they stop being listed.` +
    `\n\nThe directory is APPENDED, never prepended, and that is not a style choice. Prepending is the idiom already used in this machine's own .zshrc — and here it would put ${dir}/codex (0.142.5) ahead of the Homebrew cask's 0.157.1, silently downgrading a tool by fifteen minor versions while claiming to have fixed something.`;

  if (!init) {
    return {
      kind: conflict.kind,
      subject: conflict.subject,
      title: `Put ${dir} on PATH`,
      rationale,
      steps: [],
      blocked: `No shell init file was identified, so there is nowhere to write this safely. Add \`export PATH="$PATH:${dir}"\` to your shell's init file by hand — APPENDED, so it cannot shadow a newer copy of something you already have.`,
      minAuthLevel: AUTH_CONFIG,
      permanent: true,
    };
  }

  if (init.alreadyPresent) {
    return {
      kind: conflict.kind,
      subject: conflict.subject,
      title: `${dir} is already exported in ${init.path}`,
      rationale: `${rationale}\n\nThe line is already in ${init.path}, so this shell has not read it yet — the file is sourced at login, and the session you are in started before it was written. Open a new terminal, or run \`exec $SHELL -l\`.`,
      steps: [],
      verify: [
        "sh",
        "-lc",
        `case ":$PATH:" in *":${dir}:"*) echo on-path ;; *) echo MISSING ;; esac`,
      ],
      minAuthLevel: AUTH_CONFIG,
      permanent: true,
    };
  }

  return {
    kind: conflict.kind,
    subject: conflict.subject,
    title: `Put ${dir} on PATH via ${init.path}`,
    rationale,
    /**
     * TWO steps, and the backup is the first one rather than something the executor promises to
     * have done. A guard that lives only in a comment is a guard nobody can audit — and this
     * writes to the file that decides whether the user's next login shell works at all. On a
     * machine whose recovery path is "open a terminal", a broken `.zshrc` is the one failure
     * here that costs more than the problem being fixed.
     */
    steps: [
      {
        argv: ["cp", "-p", init.path, `${init.path}${EDIT_GUARD.backupSuffix}`],
        purpose: `copy ${init.path} aside before touching it`,
        risk: "reversible",
        undo: ["rm", "-f", `${init.path}${EDIT_GUARD.backupSuffix}`],
      },
      {
        /**
         * `printf`, never `echo`: `echo` with a backslash or a leading `-` is
         * implementation-defined across shells, and the string being written is a PATH export
         * built from a filesystem path. The line arrives as an ARGUMENT (`$1`), not spliced into
         * the script text, so a directory containing a quote or a `$` cannot become code.
         */
        argv: ["sh", "-c", 'printf "%s\\n" "$1" >> "$2"', "sh", init.line, init.path],
        displayAs: [`append to ${init.path}:`, ...init.line.split("\n").map((l) => `  ${l}`)],
        purpose: `append the PATH export to ${init.path}`,
        risk: "edits-shell-init",
        undo: ["cp", "-p", `${init.path}${EDIT_GUARD.backupSuffix}`, init.path],
      },
    ],
    verify: [
      "sh",
      "-lc",
      `case ":$PATH:" in *":${dir}:"*) echo on-path ;; *) echo MISSING ;; esac`,
    ],
    keeps: `every line already in ${init.path} — the repair appends and never rewrites, and takes a ${EDIT_GUARD.backupSuffix} copy first.`,
    minAuthLevel: AUTH_CONFIG,
    permanent: true,
  };
}

/**
 * A client and the server it drives are different versions.
 *
 * ALWAYS blocked, and ollama is why. CLAUDE.md §2.8 is unambiguous: the brew service and
 * Ollama.app fought over :11434 and crash-looped 36,135 times, the brew service is stopped on
 * purpose, and the guards must not be routed around. Every mechanical "fix" here — removing the
 * formula, starting the service, installing the cask over the app — is a way to end up with two
 * daemons contending for one port, or with none.
 *
 * It is also the wrong shape of problem for a scripted repair: the question "which ollama do you
 * want to be the real one" is a decision about how the user works, not a defect to be corrected.
 * So this states the fact, names the consequence precisely, and stops.
 */
function skew(conflict: Conflict, ctx: RemedyContext): Remedy {
  const res = ctx.resolution;
  const winner = res?.winner;
  const app = res?.copies.find((c) => c.owner === "app-bundle");

  return {
    kind: conflict.kind,
    subject: conflict.subject,
    title: `${conflict.subject}: the client on PATH is not the server answering requests`,
    rationale: `Upgrading the client moves the version you SEE and changes nothing that runs. ${
      app
        ? `The server belongs to ${app.realPath}, which updates itself — quit and reopen the app, or use its own update prompt. The ${winner ? ownerLabel(winner.owner) : "PATH"} CLI is redundant here and upgrading it will never move the server.`
        : "Find which process is bound to the port before changing anything: the owner is whatever bound it last, not whichever installer you remember using."
    }`,
    steps: [],
    blocked:
      "Prometheus will not repair this automatically. Two ollamas contending for :11434 crash-looped 36,135 times on this machine, and the brew service is stopped deliberately (CLAUDE.md §2.8) — so removing the formula, starting the service, or installing the cask over the app bundle each risk ending with two daemons or none. Decide which one you want to own the port, then do it by hand.",
    /**
     * The verification is a MEASUREMENT, offered even though the repair is blocked, because the
     * first correct step is always "find out which binary actually holds the port" — and the
     * answer is routinely not the one the user expects.
     */
    verify: [
      "sh",
      "-lc",
      "ps eww -p \"$(lsof -nP -iTCP:11434 -sTCP:LISTEN -t)\" | tr ' ' '\\n' | grep OLLAMA_",
    ],
    minAuthLevel: AUTH_DESTRUCTIVE,
    permanent: false,
  };
}

/* ───────────────────────────── assembling the set ───────────────────────────── */

export interface RemedyPlanInput {
  conflicts: readonly Conflict[];
  /** resolutions by tool id, so a remedy can see which copy to remove. */
  resolutions?: readonly ToolResolution[];
  /**
   * The USER's home, for expanding the `~` in `CASK_ZAP_PATHS` before the hazard comparison.
   *
   * Named `userHome` and not `home` on purpose: `CheckDeps.home` in the live layer means the
   * PROMETHEUS STATE DIRECTORY, and the two silently merged once already — same name, same
   * `string` type, invisible to `tsc` — which made every $HOME-based install classify as
   * `unknown`. See `ResolveDeps.userHome` for the full account.
   */
  userHome?: string;
  shellInit?: RemedyContext["shellInit"];
  binDirs?: Readonly<Record<string, string>>;
}

/**
 * Every repair this module knows for a set of conflicts, in the order the conflicts came in.
 *
 * Conflicts with no known repair are simply absent — the caller keeps rendering the conflict
 * itself, which `conflicts.ts` already does well. This adds the missing half; it does not
 * replace the diagnosis, and a missing remedy must never suppress a finding.
 */
export function remediesFor(input: RemedyPlanInput): Remedy[] {
  const byTool = new Map((input.resolutions ?? []).map((r) => [r.tool, r]));
  const out: Remedy[] = [];
  for (const c of input.conflicts) {
    const res = byTool.get(c.subject);
    const r = remedyFor(c, {
      ...(res ? { resolution: res } : {}),
      ...(input.userHome ? { home: input.userHome } : {}),
      ...(input.shellInit ? { shellInit: input.shellInit } : {}),
      ...(input.binDirs?.[c.subject] ? { binDir: input.binDirs[c.subject] } : {}),
    });
    if (r) out.push(r);
  }
  return out;
}

/**
 * Remedies that can actually be RUN — the ones a `fix` command would execute.
 *
 * A remedy with `blocked` set or no steps is informational, and offering it as runnable would
 * make `/updates fix` print "nothing to do" for a machine full of findings.
 */
export function runnable(remedies: readonly Remedy[]): Remedy[] {
  /**
   * ONE per subject. The same duplicate install produces several conflicts that share a single
   * repair — a `downgrade-offer` from the manager's row and a `duplicate-install` from the
   * resolution both resolve to "remove the Homebrew cask copy of claude". Returning it twice
   * would have an executor run `brew uninstall` a second time against a cask that is already
   * gone, and report the failure as if the repair had not worked.
   */
  const seen = new Set<string>();
  return remedies.filter((r) => {
    if (r.blocked || r.steps.length === 0 || seen.has(r.subject)) return false;
    seen.add(r.subject);
    return true;
  });
}

/** Render an argv for DISPLAY only. Quoting here is cosmetic; nothing executes this string. */
export function displayCommand(argv: readonly string[]): string {
  return argv.map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}
