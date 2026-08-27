/**
 * revert-outcome.ts — decide what a checkpoint revert may claim, from what the disk actually did.
 *
 * `revertTurn` restored files and then truncated the chat UNCONDITIONALLY:
 *
 *     await api.fsWrite(…).catch(() => undefined);
 *     await api.fsDelete(…).catch(() => undefined);
 *     revertToTurn(sid, turnIndex);
 *
 * Two ways to lose the failure — `.catch(() => undefined)` swallows a throw, and the resolved
 * `{ok:false}` was never read — after which the chat rolled back over a disk that had not. The
 * comment directly above that code says the fs-then-truncate ordering exists so that "a failed
 * write [does not show] a reverted chat over an unreverted disk", which is exactly what happened:
 * the ordering was right and nothing ever checked the result it was ordered for.
 *
 * PURE on purpose. The decision is the part worth testing, and it is untestable inside a React
 * callback that also talks to IPC — the same split as `profile-notice.ts`.
 */

/** One file operation the restore plan attempted. */
export interface RevertStepResult {
  /** workspace-relative path, for the message. */
  path: string;
  /** `write` or `delete` — a delete that failed leaves a file the turn created. */
  kind: "write" | "delete";
  ok: boolean;
  error?: string;
}

export interface RevertOutcome {
  /**
   * May the chat be truncated?
   *
   * ONLY when every file operation succeeded. A partial revert that also rewinds the
   * conversation destroys the user's ability to see what the turn had done — the transcript is
   * the only remaining record of the changes still on disk.
   */
  truncate: boolean;
  /** A line for the user. Empty when the revert was clean. */
  notice: string;
  /** The paths that did not come back, for a caller that wants to list them. */
  failed: readonly string[];
}

/** How many failing paths to name before summarising the rest. */
const NAMED = 3;

/**
 * Fold the per-file results into the one decision the caller has to make.
 *
 * An EMPTY plan is a success: a checkpoint whose turn touched no files reverts trivially, and
 * refusing to truncate there would make Revert appear broken on the commonest case.
 */
export function revertOutcome(results: readonly RevertStepResult[]): RevertOutcome {
  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) return { truncate: true, notice: "", failed: [] };

  const failed = failures.map((f) => f.path);
  const named = failed.slice(0, NAMED).join(", ");
  const more = failed.length > NAMED ? ` and ${failed.length - NAMED} more` : "";
  // The first recorded reason is worth carrying: "permission denied" and "read-only file
  // system" send the user somewhere completely different.
  const why = failures.find((f) => f.error)?.error;
  return {
    truncate: false,
    notice:
      `⚠ revert incomplete — ${failed.length} file${failed.length === 1 ? "" : "s"} could not be ` +
      `restored (${named}${more})${why ? `: ${why}` : ""}. ` +
      "The conversation was left intact so you can still see what this turn changed.",
    failed,
  };
}
