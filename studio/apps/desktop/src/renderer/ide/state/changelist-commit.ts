/**
 * ide/state/changelist-commit.ts — the commit-ONE-changelist git choreography (APP-038).
 *
 * git has no changelist concept, so committing a single list is pure staging
 * choreography: reset the index, stage EXACTLY the list's files, commit with the
 * message, then re-stage the OTHER lists' previously-staged files. On ANY failure the
 * ORIGINAL staged set is restored (transactional-ish) so a mid-op error never leaves
 * the index scrambled across lists. Extracted here (no react/window) so the sequence
 * is unit-testable against a fake git api. GitPanel owns the UI state around it.
 */

/** The minimal git surface the choreography needs (a subset of window.prometheus.ide). */
export interface ChangelistGitApi {
  gitUnstage(root: string, files: string[]): Promise<{ ok: boolean; error?: string }>;
  gitStage(root: string, files: string[]): Promise<{ ok: boolean; error?: string }>;
  gitCommit(root: string, message: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * The file's STAGED diff (`git diff --cached -- <file>`), used to restore index CONTENT.
   *
   * Optional so an older caller still type-checks; when it is absent the choreography falls
   * back to re-staging by path and says so in `flattened`.
   */
  gitDiff?(root: string, file: string, staged?: boolean): Promise<{ ok: boolean; diff?: string }>;
  /** `git apply --cached -` with the patch on STDIN (APP-084's per-hunk stager). */
  gitApplyPatch?(
    root: string,
    patch: string,
    opts?: { reverse?: boolean },
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface CommitListResult {
  ok: boolean;
  error?: string;
  /**
   * Files whose PARTIAL staging could not be preserved and was flattened to fully-staged.
   *
   * Empty in the normal case. Non-empty means the caller must tell the user, because the index
   * no longer says what they set it to say.
   */
  flattened?: string[];
}

/**
 * Commit exactly `targets` from the worktree. `originalStaged` is the pre-op staged
 * set (captured from git status) so the other lists' staged files can be restored
 * afterwards — and the WHOLE original set restored on failure.
 */
export async function commitChangelistFiles(
  api: ChangelistGitApi,
  params: { root: string; message: string; targets: string[]; originalStaged: string[] },
): Promise<CommitListResult> {
  const { root, targets, originalStaged } = params;
  const message = params.message.trim();
  if (!message) return { ok: false, error: "empty commit message" };
  if (targets.length === 0) return { ok: false, error: "no changed files in this list" };
  const restore = originalStaged.filter((p) => !targets.includes(p));
  /**
   * Capture the index CONTENT of everything we are about to clear — not just which paths were
   * staged.
   *
   * `gitUnstage(root, [])` is `git restore --staged .`, and the old restore was
   * `gitStage(root, restore)` = `git add -- <paths>`, which stages the CURRENT WORKTREE content.
   * For a file the user had partially staged with the panel's own per-hunk stager, that silently
   * promoted the whole file to staged — and the hunks they had deliberately left out went into
   * the NEXT commit. The header and the inline comment both claimed the original staged set was
   * restored "exactly"; only path membership ever was.
   *
   * The per-file staged diff replayed through `git apply --cached` restores the real content. A
   * file whose staged diff we cannot capture or replay is reported in `flattened` rather than
   * being quietly flattened, so the caller can say so.
   */
  const preserved = new Map<string, string>();
  const flattened: string[] = [];
  const canPreserve = typeof api.gitDiff === "function" && typeof api.gitApplyPatch === "function";
  if (canPreserve) {
    for (const file of restore) {
      try {
        const d = await api.gitDiff?.(root, file, true);
        const patch = d?.ok ? (d.diff ?? "") : "";
        // A binary file has no textual patch to replay ("Binary files … differ"), so it cannot
        // round-trip this way; flag it rather than pretend.
        if (patch.trim() === "" || /^Binary files /m.test(patch)) flattened.push(file);
        else preserved.set(file, patch);
      } catch {
        flattened.push(file);
      }
    }
  } else {
    flattened.push(...restore);
  }

  try {
    const cleared = await api.gitUnstage(root, []); // reset the index to a known state
    if (!cleared.ok) throw new Error(cleared.error ?? "unstage failed");
    const staged = await api.gitStage(root, targets);
    if (!staged.ok) throw new Error(staged.error ?? "stage failed");
    const committed = await api.gitCommit(root, message);
    if (!committed.ok) throw new Error(committed.error ?? "commit failed");
    // the committed files are gone from the worktree; restore the OTHERS' index content.
    for (const [file, patch] of preserved) {
      const applied = await api.gitApplyPatch?.(root, patch).catch(() => ({ ok: false }));
      // A patch that will not replay (the worktree moved under us) degrades to path re-staging —
      // the OLD behaviour, but reported rather than silent.
      if (!applied?.ok) {
        flattened.push(file);
        await api.gitStage(root, [file]);
      }
    }
    // whatever we never had a patch for is restored the only way left: by path.
    const byPath = flattened.filter((f) => !preserved.has(f));
    if (byPath.length > 0) await api.gitStage(root, byPath);
    return flattened.length > 0 ? { ok: true, flattened } : { ok: true };
  } catch (e) {
    /**
     * Transactional restore: put the ORIGINAL staged set back — content included where we have
     * it. Order matters. Everything we hold a patch for is replayed onto a CLEARED index; only
     * the files we could not capture are re-staged by path, because `git add` after a replay
     * would flatten the very content the replay just restored.
     */
    await api.gitUnstage(root, []);
    const replayed = new Set<string>();
    for (const [file, patch] of preserved) {
      const applied = await api.gitApplyPatch?.(root, patch).catch(() => ({ ok: false }));
      if (applied?.ok) replayed.add(file);
    }
    const byPath = originalStaged.filter((f) => !replayed.has(f));
    if (byPath.length > 0) await api.gitStage(root, byPath);
    return { ok: false, error: e instanceof Error ? e.message : "changelist commit failed" };
  }
}
