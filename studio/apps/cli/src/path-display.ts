/**
 * path-display.ts — how a filesystem path is shown to a human.
 *
 * ONE copy. There were two byte-identical `shortCwd` functions — one in the readline host, one
 * in the TUI bridge — and a third was about to be written for the fleet report. Three private
 * copies of a display rule is how the same path ends up rendered three ways on three surfaces of
 * the same product; a fix applied to one of them is invisible to the others.
 */

/**
 * Shorten an absolute path under $HOME to a leading `~`.
 *
 * Boundary-checked: a sibling like `/home/user-x` (home `/home/user`) must not be mis-collapsed
 * to `~-x`, which is both wrong and unrecognisable.
 */
export function shortCwd(dir: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return dir;
  if (dir === home) return "~";
  return dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`)
    ? `~${dir.slice(home.length)}`
    : dir;
}

/**
 * Like `shortCwd`, but for the ONE-TIME startup banner: the home folder itself keeps its real
 * full path rather than collapsing to a bare `~`.
 *
 * A lone `~` reads clearly to an experienced terminal user and is nearly invisible to everyone
 * else — and it is the one line in the banner that answers "where am I". A NESTED path still
 * collapses, because it is never just that one character and the banner stays short for a deep
 * tree. The per-turn status lines keep plain `shortCwd`: that tilde is seen every prompt, not once.
 */
export function bannerCwd(dir: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home && dir === home ? dir : shortCwd(dir);
}
