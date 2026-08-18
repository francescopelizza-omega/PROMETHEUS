/**
 * renderer/shared/path-completion/logic.ts — the PURE half of "@"-path completion for
 * ANY text field (not just AgentPane's composer, which keeps its own richer sym:/folder:/
 * docs: mention system in ide/ai/mention.ts). Reuses that file's caret-anchored
 * `detectActiveMention`/`replaceMention` for the "@" trigger itself — only bare FILE
 * mentions are handled here — and adds the directory/fragment split + splice math a
 * live, drill-down completion dropdown needs.
 *
 * No node:* imports (biome bars them from renderer code) and no DOM — string math only,
 * so this is unit-testable exactly like the CLI's tui/path-mentions.ts, which it mirrors.
 */

/** Split a bare mention's query (everything after "@") into the directory typed so far
 *  and the fragment being completed, on the LAST "/". */
export function splitMentionQuery(query: string): { dirPart: string; frag: string } {
  const slash = query.lastIndexOf("/");
  if (slash < 0) return { dirPart: "", frag: query };
  // query.slice(0, slash) for a SINGLE leading slash (slash === 0) is "" — which would
  // silently drop the "/" and make "@/etc" resolve as a RELATIVE fragment against baseDir
  // instead of the filesystem root. Keep the lone "/" itself as dirPart in that case (still
  // correctly recognized as absolute by resolveMentionDir's `startsWith("/")` check).
  const dirPart = slash === 0 ? "/" : query.slice(0, slash);
  return { dirPart, frag: query.slice(slash + 1) };
}

/** POSIX join (no node:path in the sandboxed renderer). This app targets macOS/Linux. */
export function joinPath(base: string, rel: string): string {
  if (rel === "") return base;
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${b}/${rel}`;
}

/** Resolve a typed directory fragment to an absolute-ish path: absolute as-is, else
 *  relative to `baseDir` (typically the open workspace root). */
export function resolveMentionDir(dirPart: string, baseDir: string): string {
  if (dirPart === "") return baseDir;
  if (dirPart.startsWith("/")) return dirPart;
  return joinPath(baseDir, dirPart);
}

export interface MentionAcceptResult {
  text: string;
  /** caret position (UTF-16 code units — matches a DOM <textarea>'s selectionStart). */
  caret: number;
  /** the resolved absolute path — set only for a FILE accept (a directory keeps the
   *  mention open one level deeper; frecency is recorded on files, not on the way there). */
  acceptedPath?: string;
}

/**
 * Splice the chosen entry into `text` at the active mention, mirroring the CLI's
 * tui/path-mentions.ts `acceptPathAc`: a directory keeps the mention "open" one level
 * deeper (trailing "/", no space — the next re-detect naturally lists the new, deeper
 * directory with an empty fragment); a file closes it (trailing space, unless the text
 * right after it already starts with whitespace, to avoid a double space).
 */
export function acceptMention(
  text: string,
  active: { start: number; token: string },
  dirPart: string,
  dirPath: string,
  entryName: string, // already carries a trailing "/" for directories
  isDir: boolean,
): MentionAcceptResult {
  const tokenEnd = active.start + 1 + active.token.length;
  // dirLen = how many of the token's chars are "the directory part, including its trailing
  // separator". Normally that's dirPart.length + 1 (the "/" that followed it in the typed
  // token); but for the root case dirPart is ITSELF "/" (see splitMentionQuery) — it already
  // IS the separator, so adding another +1 would double it and corrupt the splice.
  const dirLen = dirPart === "" ? 0 : dirPart.endsWith("/") ? dirPart.length : dirPart.length + 1;
  const headEnd = active.start + 1 + dirLen; // just past "@" + dirPart + "/"
  const head = text.slice(0, headEnd);
  const tail = text.slice(tokenEnd);
  const needsSpace = !isDir && (tail === "" || !/^\s/.test(tail));
  const insertion = isDir ? entryName : `${entryName}${needsSpace ? " " : ""}`;
  const nextText = `${head}${insertion}${tail}`;
  const nextCaret = head.length + insertion.length;
  const acceptedPath = isDir ? undefined : joinPath(dirPath, entryName);
  return { text: nextText, caret: nextCaret, acceptedPath };
}
