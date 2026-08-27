/**
 * profile-notice.ts — what the Profile panel should TELL the user about a completed run.
 *
 * Extracted from `ProfilePanel.tsx` because `.tsx` cannot be loaded by node:test, which is why
 * the defect below survived: the panel did
 *
 *     if (res.note) setInfo(res.note);
 *     else if (res.timedOut) setInfo("partial profile (wall-clock cap hit)");
 *
 * and `profile.py` sets `note` on EVERY successful run ("cProfile edge-reconstructed
 * (approximate) folds; py-spy gives true sampled stacks" — measured). So the `timedOut` arm was
 * unreachable: a run that hit the wall-clock cap showed the generic engine note and nothing about
 * being cut short, and the user read a partial flame graph as a complete one.
 *
 * `runError` matters more than either — it means the profiled script CRASHED and the graph is
 * import machinery (see `ide-ipc.ts`, where the mapper used to drop it entirely). Ordering is by
 * how badly the reader would be misled: crash, then truncation, then the informational note.
 */

export interface ProfileNoticeInput {
  /** the profiled script's own error, when it raised. */
  runError?: string;
  /** the run hit the wall-clock cap and the profile is partial. */
  timedOut?: boolean;
  /** the sample set was cut short. */
  truncated?: boolean;
  /** the engine's informational note — present on essentially every successful run. */
  note?: string;
}

/** The one-line notice, or "" when there is genuinely nothing worth saying. */
export function profileNotice(res: ProfileNoticeInput): string {
  const parts: string[] = [];
  if (res.runError) {
    parts.push(
      `⚠ the profiled script raised ${res.runError} — this graph is startup/import work, not your code`,
    );
  }
  if (res.timedOut) parts.push("partial profile (wall-clock cap hit)");
  if (res.truncated) parts.push("sample set truncated");
  if (res.note) parts.push(res.note);
  return parts.join(" · ");
}
