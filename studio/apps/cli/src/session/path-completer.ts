// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/path-completer.ts — a filesystem path completer for the session readline
 * (the natural `tab` directory-completion the user expects when picking a download
 * folder). It follows node:readline's `completer` contract: return `[hits, line]`
 * where every hit is a FULL replacement for `line` that startsWith(line), so readline
 * fills the common prefix on `tab` and lists candidates when several match.
 *
 * Directories get a trailing `/` (so tab keeps drilling in). `~` expands to $HOME but
 * is preserved in the displayed candidate. Pure + fail-soft: an unreadable dir yields
 * no hits (never throws into readline). fs is allowed in apps/cli (only child_process
 * is gated); injected for tests.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** The fs surface the completer needs (injected in tests). */
export interface CompleterFs {
  readdirSync: (p: string) => string[];
  isDir: (p: string) => boolean;
}

/** The real filesystem — also reused by tui/path-mentions.ts's "@"-completion so both
 *  completers share one readdir/isDir implementation. */
export const defaultFs: CompleterFs = {
  readdirSync: (p) => readdirSync(p),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Options for {@link completePath}. */
export interface CompleteOpts {
  /** keep only directory candidates (CLI-066 folder prompts); default false → all entries. */
  dirsOnly?: boolean;
}

/**
 * Complete a partial path. Returns `[hits, line]` (readline contract). `hits` are full
 * candidate paths (with `~` preserved when the user typed it); directories end in `/`. With
 * `dirsOnly`, plain files are excluded (the directory filter runs BEFORE the `/`-append).
 */
export function completePath(
  line: string,
  fs: CompleterFs = defaultFs,
  opts: CompleteOpts = {},
): [string[], string] {
  const home = homedir();
  const usesTilde = line.startsWith("~/") || line === "~";
  // STRING concat (not path.join) so a trailing "/" survives — `~/` must list $HOME,
  // not its parent. (`~` → $HOME; `~/x` → $HOME/x; `~/` → $HOME/.)
  const expanded = usesTilde ? home + line.slice(1) : line;

  // the directory to list, and the fragment we're completing within it.
  const dir = expanded.endsWith("/") ? expanded : dirname(expanded) || ".";
  const frag = expanded.endsWith("/") ? "" : basename(expanded);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir || "/");
  } catch {
    return [[], line];
  }

  // map a full path back into the SAME notation the user typed (~ only when it's
  // genuinely under $HOME, else absolute) — never slice a path that isn't home-rooted.
  const toDisplay = (full: string): string => {
    if (!usesTilde) return full;
    if (full === home) return "~";
    // boundary-checked so `/home/user-x` (home `/home/user`) isn't mis-rewritten to `~-x`.
    return full.startsWith(`${home}/`) || full.startsWith(`${home}\\`)
      ? `~${full.slice(home.length)}`
      : full;
  };

  const hits = entries
    // skip dotfiles UNLESS the user is explicitly typing a leading dot (e.g. `.ssh`).
    .filter((e) => e.startsWith(frag) && (frag.startsWith(".") || !e.startsWith(".")))
    // dirsOnly: filter BEFORE the slash-append so the endswith("/") check can't misfire.
    .filter((e) => !opts.dirsOnly || fs.isDir(join(dir, e)))
    .map((e) => {
      const full = join(dir, e);
      const cand = toDisplay(full);
      return fs.isDir(full) ? `${cand}/` : cand;
    })
    .filter((c) => c.startsWith(line));

  return [hits, line];
}

/** The longest common prefix of a list of strings (byte-wise, case-sensitive). */
export function longestCommonPrefix(strs: readonly string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0] ?? "";
  for (const s of strs) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") break;
  }
  return prefix;
}

/** One Tab step: the new buffer + the full candidate list (for the hint row). */
export interface CycleStep {
  buffer: string;
  candidates: string[];
}

/**
 * A stateful Tab cycler over {@link completePath} (CLI-066): the FIRST Tab expands to the longest
 * common prefix (and stops there if that changed the buffer); once the buffer IS the common prefix,
 * repeated Tab cycles the candidates in order and wraps. A single candidate completes fully. Zero
 * candidates leaves the buffer untouched. Call `reset()` on any non-Tab edit so the next Tab is
 * fresh. PURE (injected fs) — the app only wires keys to it.
 */
export interface PathCycler {
  tab(buffer: string): CycleStep;
  reset(): void;
}

export function createPathCycler(fs: CompleterFs = defaultFs, dirsOnly = false): PathCycler {
  let cands: string[] = [];
  let idx = 0;
  let cycling = false;

  const reset = (): void => {
    cands = [];
    idx = 0;
    cycling = false;
  };

  return {
    reset,
    tab(buffer: string): CycleStep {
      // continuing a live cycle (the buffer is still the candidate we last produced)?
      if (cycling && cands.length > 0 && buffer === cands[idx]) {
        idx = (idx + 1) % cands.length;
        return { buffer: cands[idx] ?? buffer, candidates: cands };
      }
      // fresh completion.
      cycling = false;
      const [hits] = completePath(buffer, fs, { dirsOnly });
      if (hits.length === 0) return { buffer, candidates: [] }; // no-op (deliverable 4)
      if (hits.length === 1) return { buffer: hits[0] ?? buffer, candidates: hits };
      const lcp = longestCommonPrefix(hits);
      if (lcp.length > buffer.length) {
        // common-prefix expansion FIRST — stop here; a later Tab (buffer===lcp) begins cycling.
        cands = hits;
        idx = 0;
        return { buffer: lcp, candidates: hits };
      }
      // the buffer already IS the common prefix → begin cycling from the first candidate.
      cands = hits;
      idx = 0;
      cycling = true;
      return { buffer: cands[0] ?? buffer, candidates: cands };
    },
  };
}

/* ── path-taking slash commands ───────────────────────────────────────────── */

/**
 * The slash commands whose ARGUMENT is a filesystem path, and whether that argument may only
 * be a directory.
 *
 * This table is the single source of truth for both completers: the TUI's live dropdown
 * (tui/path-mentions.ts) and the readline host's Tab completer below. `/cd ~/pro<Tab>` has to
 * behave the same way on both surfaces — a user who learns it in one and finds it dead in the
 * other has learned that Tab completion "doesn't work", which is exactly the report this table
 * exists to answer.
 *
 * Keys are the registry's canonical command names, lowercased, without the leading "/".
 */
export const PATH_ARG_COMMANDS: ReadonlyMap<string, { dirsOnly: boolean }> = new Map([
  ["cd", { dirsOnly: true }],
  ["cwd", { dirsOnly: true }],
  ["add-dir", { dirsOnly: true }],
  // `/in` names a DESTINATION folder, so it completes like /cd and /cwd, not like /cat.
  ["in", { dirsOnly: true }],
  ["ls", { dirsOnly: true }],
  // `/cat` takes a FILE, so it is the one path-arg command that must offer files too.
  ["cat", { dirsOnly: false }],
  ["mention", { dirsOnly: false }],
  ["export", { dirsOnly: false }],
]);

/** `/cmd` + the whitespace that ends it — the head that precedes a path argument. */
const SLASH_PATH_HEAD = /^\/([A-Za-z][\w-]*)([ \t]+)/;

/** Chars that may appear inside a path argument token. Superset of the "@"-mention token set:
 *  `~` is included, because `/cd ~/x` is how people actually type a home-relative path, and
 *  stopping the token scan at the `~` would make `/x` look like an ABSOLUTE path. */
export const PATH_TOKEN_CHARS = /[\w./~-]/;

/** A path argument located inside a slash-command line. */
export interface SlashPathArg {
  /** code-point index where the path token starts. */
  tokenStart: number;
  /** the token typed so far (may be ""). */
  token: string;
  dirsOnly: boolean;
}

/**
 * Locate the path argument under `cursor` in a slash-command line, or null when there isn't one
 * (not a slash command, not a path-taking one, the caret is still in the command word, or the
 * token under the caret is a flag like `--remove`).
 *
 * `cursor` is a CODE-POINT index; the head this matches is ASCII, so its UTF-16 length is also
 * its code-point length.
 */
export function findSlashPathArg(input: string, cursor: number): SlashPathArg | null {
  const m = SLASH_PATH_HEAD.exec(input);
  if (!m) return null;
  const spec = PATH_ARG_COMMANDS.get((m[1] as string).toLowerCase());
  if (!spec) return null;
  const chars = [...input];
  const pos = Math.max(0, Math.min(cursor, chars.length));
  const argStart = (m[0] as string).length;
  if (pos < argStart) return null; // caret still inside the command word / its trailing space
  let i = pos;
  while (i > argStart && PATH_TOKEN_CHARS.test(chars[i - 1] as string)) i -= 1;
  if (chars[i] === "-") return null; // `--remove`, `--json`, … — a flag, not a path
  return { tokenStart: i, token: chars.slice(i, pos).join(""), dirsOnly: spec.dirsOnly };
}

/**
 * The readline host's twin of the TUI dropdown: Tab-complete the path ARGUMENT of a
 * path-taking slash command. Returns readline's `[hits, line]` where each hit is a full
 * replacement for `line`, or null when the line has no path argument to complete (the caller
 * then falls back to whatever it does with an ordinary line).
 */
export function completeSlashArg(
  line: string,
  fs: CompleterFs = defaultFs,
): [string[], string] | null {
  const arg = findSlashPathArg(line, [...line].length);
  if (!arg) return null;
  const [hits] = completePath(arg.token, fs, { dirsOnly: arg.dirsOnly });
  const head = [...line].slice(0, arg.tokenStart).join("");
  return [hits.map((h) => head + h), line];
}
