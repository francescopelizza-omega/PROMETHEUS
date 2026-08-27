/**
 * state/replace-apply.ts — the bulk replace-in-files loop, as a pure function over seams.
 *
 * The panel's own copy of this loop awaited `fsWrite` and DISCARDED the result, then counted the
 * file as replaced. A refused or failed write was therefore indistinguishable from a successful
 * one, and the panel reported "replaced N matches in M files" over files that never changed —
 * a scope directory outside the granted working set, or one read-only file, produced a confident
 * success message. Extracted here because the component is a .tsx the node:test harness cannot
 * load (the desktop tsconfig is `noEmit`, and JSX cannot be type-stripped), so the counting rule
 * had no way to be tested where it lived.
 */

/**
 * The result of re-applying a file's accepted matches to its freshly-read text.
 *
 * A discriminated union, matching the panel's own `applyToFreshText`: a stale file carries no
 * text to write, so the failure case must not pretend to have one.
 */
export type FreshApply = { ok: true; applied: number; text: string } | { ok: false; stale: number };

/** The IO the loop needs, injected so it can be driven without a renderer. */
export interface ReplaceIo {
  read(uri: string): Promise<{ ok: boolean; text?: string } | null | undefined>;
  write(uri: string, text: string): Promise<{ ok: boolean; error?: string } | null | undefined>;
}

export interface ReplaceTally {
  /** files actually written. */
  files: number;
  /** matches actually replaced. */
  matches: number;
  /** files whose text moved under the preview, or that could not be read. */
  skipped: number;
  /** files whose WRITE was refused — never counted as replaced. */
  failed: { uri: string; error: string }[];
}

/**
 * Apply the accepted matches for each file and tally ONLY what really landed.
 *
 * A write that fails goes to `failed`, never to `files`/`matches`: the counts a user reads have
 * to mean "this happened", or the message is worse than no message at all.
 */
export async function applyReplacements<F extends { uri: string }>(
  io: ReplaceIo,
  files: readonly F[],
  accepted: (file: F) => readonly string[],
  applyToFreshText: (file: F, ids: readonly string[], text: string) => FreshApply,
): Promise<ReplaceTally> {
  const tally: ReplaceTally = { files: 0, matches: 0, skipped: 0, failed: [] };
  for (const file of files) {
    const ids = accepted(file);
    if (ids.length === 0) continue;
    const read = await io.read(file.uri).catch(() => null);
    if (!read?.ok || read.text === undefined) {
      tally.skipped += 1;
      continue;
    }
    const applied = applyToFreshText(file, ids, read.text);
    if (!applied.ok) {
      tally.skipped += 1;
      continue;
    }
    if (applied.applied === 0) continue;
    const wrote = await io.write(file.uri, applied.text).catch(() => null);
    if (!wrote?.ok) {
      tally.failed.push({ uri: file.uri, error: wrote?.error ?? "write failed" });
      continue;
    }
    tally.files += 1;
    tally.matches += applied.applied;
  }
  return tally;
}
