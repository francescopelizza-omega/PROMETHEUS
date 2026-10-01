// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates-live/remedies-live.ts — the filesystem facts a repair plan needs.
 *
 * `updates/remedies.ts` is pure: it decides WHAT to do. This decides WHERE, because "which file
 * does this shell actually read" is a question about the disk and about the user's login shell,
 * and getting it wrong is the difference between a fix and a line nothing ever sources.
 *
 * ── WHY PICKING THE RC FILE IS THE HARD PART ────────────────────────────────────────────────
 *
 * `man zsh`, STARTUP/SHUTDOWN FILES, verbatim: "Commands are then read from $ZDOTDIR/.zshenv.
 * If the shell is a login shell, commands are read from /etc/zprofile and then $ZDOTDIR/.zprofile.
 * Then, if the shell is interactive, commands are read from /etc/zshrc and then $ZDOTDIR/.zshrc."
 *
 * So the three files are not interchangeable:
 *   • `.zshenv`  — EVERY zsh, including `zsh -c`, scripts, editor and LaunchAgent subshells.
 *   • `.zprofile`— login shells. macOS Terminal opens login shells; a LaunchAgent does not.
 *   • `.zshrc`   — interactive shells only.
 *
 * A PATH entry that a non-interactive `zsh -c` cannot see is exactly the failure being repaired,
 * so `.zshenv` is the right target for making a directory findable by everything.
 *
 * ── THE THREE REFUSALS ──────────────────────────────────────────────────────────────────────
 *
 * 1. A SYMLINK is never written through. On a machine using a dotfiles repo, chezmoi, stow or
 *    Nix home-manager, `~/.zshenv` is a link into a managed tree: writing through it silently
 *    edits a git working tree the user will later commit or lose to a re-apply, and writing
 *    ATOMICALLY (temp + rename, otherwise the correct technique) replaces the link with a regular
 *    file and detaches them from their own dotfiles.
 *
 * 2. A GENERATED BLOCK is never appended into or after. Measured on this machine, `~/.zshrc`
 *    carries `# >>> ai-cli-multi manager >>>` … `<<<` and `~/.zprofile` carries two such blocks.
 *    A tool that regenerates its block reverts anything inside it — and this user's own notes
 *    already record losing a hand-applied zsh fix exactly that way.
 *
 * 3. NOTHING IS ECHOED BACK. These files routinely hold `export ANTHROPIC_API_KEY=` and
 *    `//registry.npmjs.org/:_authToken=`. This module returns the block it would ADD and the
 *    path it would add it to; it never returns, prints or diffs the file's contents.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What a PATH repair would write, and where — or why it must not be written. */
export interface ShellInitTarget {
  /** the file to append to. */
  path: string;
  /** the exact text to append. Multi-line, and self-guarding — see `pathBlock`. */
  line: string;
  /** true when this directory is already handled in that file, so the append is a no-op. */
  alreadyPresent: boolean;
  /** set when no file may safely be written; the remedy becomes instructions instead. */
  refused?: string;
}

export interface ShellInitDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
  /** true when the path is a symlink. Separated so the refusal is testable without a link. */
  isSymlink?: (p: string) => boolean;
}

/** Markers left by tools that own a region of a dotfile and will regenerate it. */
const GENERATED_MARKER = /^#\s*>>>.*>>>\s*$/m;

/**
 * The block to append, written so that running it twice cannot extend PATH twice.
 *
 * APPENDED, never prepended, and the distinction is load-bearing rather than stylistic. The
 * prepend idiom (`PATH="$dir:$PATH"`) is what this machine's own `.zshrc` uses, so copying the
 * surrounding style is the natural mistake — and here it would place `~/.local/share/npm/bin`
 * ahead of Homebrew's bin, promoting an npm `codex` 0.142.5 over the cask's 0.157.1. The repair
 * would then have silently downgraded a tool by fifteen minor versions while reporting success,
 * which is the exact class of defect this whole feature exists to detect.
 */
export function pathBlock(dir: string): string {
  return [
    "",
    "# >>> prometheus PATH >>>",
    `# ${dir} holds executables that nothing on PATH could reach.`,
    "# APPENDED, so it can never shadow a newer copy of a tool you already have.",
    'case ":$PATH:" in',
    `  *":${dir}:"*) ;;`,
    `  *) export PATH="$PATH:${dir}" ;;`,
    "esac",
    "# <<< prometheus PATH <<<",
  ].join("\n");
}

/**
 * Where to add `dir` to PATH, or why nowhere is safe.
 *
 * Order of preference is `.zshenv` first because it is read by every zsh — including the
 * non-interactive ones that a "tool not found" failure usually comes from — and, measured here,
 * it is the only one of the three with no generated block and no existing PATH lines, so an
 * append cannot land inside someone else's managed region.
 */
export function shellInitFor(dir: string, deps: ShellInitDeps = {}): ShellInitTarget {
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((p: string) => readFileSync(p, "utf8"));
  const isLink =
    deps.isSymlink ??
    ((p: string) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    });

  const shell = env.SHELL ?? "";
  const candidates = shell.includes("bash")
    ? [".bash_profile", ".bashrc"]
    : [".zshenv", ".zprofile", ".zshrc"];

  const block = pathBlock(dir);
  let firstRefusal = "";

  for (const name of candidates) {
    const path = join(home, name);
    if (!exists(path)) continue;

    if (isLink(path)) {
      // Refusal 1. Writing through the link edits someone's dotfiles repo; writing atomically
      // over it destroys the link. Neither is ours to choose.
      firstRefusal ||= `${path} is a symlink — it is managed by a dotfiles tool (chezmoi, stow, Nix home-manager or a git repo). Add the block to that source instead; writing here would either edit the repo behind your back or replace the link with a plain file.`;
      continue;
    }

    let body = "";
    try {
      body = read(path);
    } catch {
      firstRefusal ||= `${path} could not be read, so it cannot be safely appended to.`;
      continue;
    }

    // A directory already handled here — by our block or by the user's own line — is a no-op.
    if (body.includes(dir)) {
      return { path, line: block, alreadyPresent: true };
    }

    if (GENERATED_MARKER.test(body)) {
      // Refusal 2. Appending is safe only while the end of the file is not inside, or about to be
      // swallowed by, a region some other tool regenerates.
      firstRefusal ||= `${path} contains a generated block (\`# >>> … >>>\`) owned by another tool, which may rewrite the end of the file and take this with it.`;
      continue;
    }

    return { path, line: block, alreadyPresent: false };
  }

  return {
    path: join(home, candidates[0] ?? ".zshenv"),
    line: block,
    alreadyPresent: false,
    refused:
      firstRefusal ||
      `no shell init file was found among ${candidates.map((c) => `~/${c}`).join(", ")}.`,
  };
}
