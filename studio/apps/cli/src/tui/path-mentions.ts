// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { homedir } from "node:os";
/**
 * tui/path-mentions.ts — "@"-triggered fuzzy path completion for the main composer.
 *
 * Distinct from tui/autocomplete.ts's "/"-triggered slash-command dropdown (query starts
 * at input[0]; ranks a fixed in-memory command list) and from session/path-completer.ts's
 * MODAL "ask a path" completer (rigid `startsWith`, used by wizards like the download-
 * folder prompt). This one triggers on an "@" ANYWHERE in the composer buffer, lists the
 * filesystem directory the fragment resolves to, and ranks entries by fragment/fuzzy
 * match (not a rigid prefix) via @prometheus/core/path-completion — optionally boosted by
 * this project's remembered frecency (session/path-frecency-store.ts) when enabled.
 *
 * PURE given its injected fs (mirrors path-completer.ts's contract): `syncPathAutocomplete`
 * re-lists the target directory only when the directory itself changed since `prev` — typing
 * more of the same fragment re-ranks the ALREADY-read entries instead of re-reading the disk
 * on every keystroke.
 */
import { join } from "node:path";

import { type PathEntry, rankEntries } from "@prometheus/core/path-completion";

import { type CompleterFs, defaultFs, findSlashPathArg } from "../session/path-completer.js";
import type { AcItem, AcState } from "./autocomplete.js";

/** Chars allowed in a path token after "@" — mirrors the desktop's ai/mention.ts token set
 *  (letters/digits/`_` + path-safe punctuation), so a space/newline always ends a mention. */
const TOKEN_CHARS = /[\w./-]/;

export interface PathTrigger {
  /**
   * Where the path came from.
   *
   * `"mention"` — an "@" anywhere in the composer; it sits mid-sentence, so Enter ACCEPTS the
   * highlighted entry rather than sending the turn.
   * `"slash-arg"` — the path argument of a path-taking slash command (`/cd ~/pro`); here the
   * whole line IS the path, so Tab completes and Enter RUNS the command, which is the shell
   * behaviour every user already has in their fingers.
   */
  kind: "mention" | "slash-arg";
  /** code-point index of the sigil ("@") for a mention; the token start for a slash argument. */
  start: number;
  /** code-point index of the first char of the path TOKEN itself (past any sigil). */
  tokenStart: number;
  /** the directory typed so far, e.g. "src/tui" in "@src/tui/re" ("" if none yet). */
  dirPart: string;
  /** the partial name being completed, e.g. "re" in "@src/tui/re". */
  frag: string;
  /** keep only directories in the dropdown (`/cd`, `/cwd`, `/add-dir`). */
  dirsOnly: boolean;
}

/** Split a typed path token into "the directory part" and "the fragment being completed".
 *  A LONE leading "/" stays the dirPart (dropping it would make "/etc" resolve relatively). */
function splitToken(token: string): { dirPart: string; frag: string } {
  const slash = token.lastIndexOf("/");
  return {
    dirPart: slash < 0 ? "" : slash === 0 ? "/" : token.slice(0, slash),
    frag: slash >= 0 ? token.slice(slash + 1) : token,
  };
}

/**
 * Caret-anchored detection: scan BACK from `cursor` for the last "@" not preceded by a
 * word char (so `a@b` / an email never triggers), with only token chars in between.
 * Returns null when there is no active mention under the caret.
 */
export function detectPathTrigger(input: string, cursor: number): PathTrigger | null {
  const chars = [...input];
  const pos = Math.max(0, Math.min(cursor, chars.length));
  let i = pos - 1;
  while (i >= 0) {
    const ch = chars[i] as string;
    if (ch === "@") break;
    if (!TOKEN_CHARS.test(ch)) return null;
    i -= 1;
  }
  if (i < 0 || chars[i] !== "@") return null;
  const before = i > 0 ? (chars[i - 1] as string) : "";
  if (before && /\w/.test(before)) return null; // `foo@bar` — not a mention
  // splitToken keeps a LONE leading "/" as the dirPart: dropping it would make "@/etc"
  // resolve as a RELATIVE fragment against baseDir instead of the filesystem root.
  return {
    kind: "mention",
    start: i,
    tokenStart: i + 1,
    dirsOnly: false,
    ...splitToken(chars.slice(i + 1, pos).join("")),
  };
}

/**
 * The OTHER way a path gets typed: as the argument of a path-taking slash command
 * (`/cd ~/pro`, `/add-dir ../lib`, `/mention src/x.ts`).
 *
 * Without this, `/cd` had no completion of any kind in the composer — the slash dropdown
 * closes at the first space (it is completing the command NAME) and the "@" trigger never
 * fires on a line that contains no "@". The only way through was to type the whole path
 * correctly, blind. The table of which commands take a path — and which of them accept only
 * a directory — lives in session/path-completer.ts, shared with the readline host's Tab
 * completer so the two surfaces cannot drift.
 */
export function detectSlashPathTrigger(input: string, cursor: number): PathTrigger | null {
  const arg = findSlashPathArg(input, cursor);
  if (!arg) return null;
  return {
    kind: "slash-arg",
    start: arg.tokenStart,
    tokenStart: arg.tokenStart,
    dirsOnly: arg.dirsOnly,
    ...splitToken(arg.token),
  };
}

/** Resolve a typed directory fragment to an absolute path: `~` expands to $HOME, a leading
 *  "/" is absolute already, anything else is relative to `baseDir` (typically process.cwd()). */
export function resolvePathDir(dirPart: string, baseDir: string): string {
  if (dirPart === "") return baseDir;
  if (dirPart === "~") return homedir();
  if (dirPart.startsWith("~/")) return join(homedir(), dirPart.slice(2));
  if (dirPart.startsWith("/")) return dirPart;
  return join(baseDir, dirPart);
}

export interface PathAcItem {
  /** display name — directories carry a trailing "/". */
  name: string;
  isDir: boolean;
  /** matched char indices into the BARE name (no trailing slash), for highlighting. */
  positions: number[];
}

export interface PathAcState {
  items: PathAcItem[];
  index: number;
  /** the raw fragment (no trailing slash) that produced `items`. */
  query: string;
  trigger: PathTrigger | null;
  /** the absolute directory `items` was listed from ("" when closed). */
  dirPath: string;
  /** the raw (unranked) directory listing — cached so re-typing within the SAME directory
   *  re-ranks instead of re-reading the disk on every keystroke. */
  rawEntries: PathEntry[];
}

export const EMPTY_PATH_AC: PathAcState = Object.freeze({
  items: [],
  index: 0,
  query: "",
  trigger: null,
  dirPath: "",
  rawEntries: [],
});

export function isPathOpen(state: PathAcState): boolean {
  return state.items.length > 0;
}

export interface PathCompletionCtx {
  /** relative fragments resolve against this (typically process.cwd()). */
  baseDir: string;
  fs?: CompleterFs;
  /** a per-directory frecency lookup (basename → raw score); omit to rank by fuzzy match
   *  alone (frecency disabled, or nothing recorded yet for this directory). */
  frecencyForDir?: (absoluteDirPath: string) => ReadonlyMap<string, number>;
}

function listDir(dirPath: string, fs: CompleterFs): PathEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dirPath);
  } catch {
    return [];
  }
  return names.map((name) => ({ name, isDir: fs.isDir(join(dirPath, name)) }));
}

/**
 * (Re)compute the "@"-path dropdown for the current input + caret. `ctx` is undefined when
 * path completion isn't wired up at all (e.g. a non-interactive host) — always closed then.
 */
export function syncPathAutocomplete(
  input: string,
  cursor: number,
  ctx: PathCompletionCtx | undefined,
  prev: PathAcState = EMPTY_PATH_AC,
): PathAcState {
  if (!ctx) return EMPTY_PATH_AC;
  const trigger = detectPathTrigger(input, cursor) ?? detectSlashPathTrigger(input, cursor);
  if (!trigger) return EMPTY_PATH_AC;

  const dirPath = resolvePathDir(trigger.dirPart, ctx.baseDir);
  const fs = ctx.fs ?? defaultFs;
  const reuseEntries = prev.trigger !== null && prev.dirPath === dirPath;
  const rawEntries = reuseEntries ? prev.rawEntries : listDir(dirPath, fs);

  // dotfile hiding unless the user explicitly typed a leading dot (mirrors path-completer.ts);
  // `dirsOnly` drops plain files for the commands that can only take a directory (`/cd`).
  const visible = rawEntries.filter(
    (e) =>
      (trigger.frag.startsWith(".") || !e.name.startsWith(".")) && (!trigger.dirsOnly || e.isDir),
  );
  const frecency = ctx.frecencyForDir?.(dirPath) ?? new Map<string, number>();
  const ranked = rankEntries(trigger.frag, visible, frecency);

  const items: PathAcItem[] = ranked.map((r) => ({
    name: r.isDir ? `${r.name}/` : r.name,
    isDir: r.isDir,
    positions: r.positions,
  }));
  const index =
    items.length === 0
      ? 0
      : trigger.frag === prev.query && prev.dirPath === dirPath
        ? Math.min(Math.max(prev.index, 0), items.length - 1)
        : 0;

  return { items, index, query: trigger.frag, trigger, dirPath, rawEntries };
}

/** Move the highlight by ±1 (wraps). */
export function movePathAc(state: PathAcState, delta: number): PathAcState {
  if (state.items.length === 0) return state;
  const n = state.items.length;
  return { ...state, index: (((state.index + delta) % n) + n) % n };
}

export interface PathAcceptResult {
  input: string;
  /** code-point cursor position right after the spliced-in completion. */
  cursor: number;
  /** the resolved absolute path — set only for a FILE accept (frecency is recorded on
   *  files, not on an intermediate directory step of a still-in-progress path). */
  acceptedPath?: string;
}

/**
 * Splice the highlighted item into `input` at the trigger's "@". A directory keeps the
 * mention "open" one level deeper (trailing "/", no trailing space — the very next resync
 * naturally re-lists the new, deeper directory with an empty fragment, so Tab kept pressed
 * drills down); a file closes it (trailing space, so the next keystroke doesn't glue on).
 */
export function acceptPathAc(input: string, state: PathAcState): PathAcceptResult | null {
  const sel = state.items[state.index];
  const trig = state.trigger;
  if (!sel || !trig) return null;

  const chars = [...input];
  // dirLen = how many of the token's chars are "the directory part, including its trailing
  // separator". Normally that's dirPart.length + 1 (the "/" that followed it in the typed
  // token); but for the root case dirPart is ITSELF "/" (see detectPathTrigger) — it already
  // IS the separator, so adding another +1 would double it and corrupt the splice.
  const dirLen =
    trig.dirPart === ""
      ? 0
      : trig.dirPart.endsWith("/")
        ? trig.dirPart.length
        : trig.dirPart.length + 1;
  const headEnd = trig.tokenStart + dirLen; // just past the sigil + dirPart + "/"
  const tokenEnd = headEnd + trig.frag.length;
  const head = chars.slice(0, headEnd).join("");
  const tail = chars.slice(tokenEnd).join("");
  // a trailing space keeps the next keystroke from gluing onto the filename, but only when
  // the tail doesn't already start with whitespace (else "…ts  rest" ends up double-spaced).
  const needsSpace = !sel.isDir && (tail === "" || !/^\s/.test(tail));
  const insertion = sel.isDir ? sel.name : `${sel.name}${needsSpace ? " " : ""}`;
  const nextInput = `${head}${insertion}${tail}`;
  const nextCursor = [...head, ...insertion].length;
  const acceptedPath = sel.isDir ? undefined : join(state.dirPath, sel.name);
  return { input: nextInput, cursor: nextCursor, acceptedPath };
}

/** Adapt this state to autocomplete.ts's AcState/AcItem shape so ONE renderDropdown paints
 *  both dropdowns identically — pass `{ sigil: "" }` at the call site, since a path entry
 *  shouldn't get a "/" glued on the front of it. */
export function toAcView(state: PathAcState): AcState {
  const items: AcItem[] = state.items.map((i) => ({ name: i.name, summary: "" }));
  return { items, index: state.index, query: state.query };
}
