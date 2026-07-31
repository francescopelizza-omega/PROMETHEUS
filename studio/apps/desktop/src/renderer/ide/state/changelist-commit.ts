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
}

export interface CommitListResult {
  ok: boolean;
  error?: string;
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
  try {
    const cleared = await api.gitUnstage(root, []); // reset the index to a known state
    if (!cleared.ok) throw new Error(cleared.error ?? "unstage failed");
    const staged = await api.gitStage(root, targets);
    if (!staged.ok) throw new Error(staged.error ?? "stage failed");
    const committed = await api.gitCommit(root, message);
    if (!committed.ok) throw new Error(committed.error ?? "commit failed");
    // the committed files are gone from the worktree; re-stage the OTHERS.
    const restore = originalStaged.filter((p) => !targets.includes(p));
    if (restore.length > 0) await api.gitStage(root, restore);
    return { ok: true };
  } catch (e) {
    // transactional restore: put the ORIGINAL staged set back exactly.
    await api.gitUnstage(root, []);
    if (originalStaged.length > 0) await api.gitStage(root, originalStaged);
    return { ok: false, error: e instanceof Error ? e.message : "changelist commit failed" };
  }
}
