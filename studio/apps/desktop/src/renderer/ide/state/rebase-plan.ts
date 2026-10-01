// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/rebase-plan.ts — the PURE interactive-rebase view-model (APP-082).
 *
 * The GitPanel rebase editor edits a todo list (one row per commit in `base..HEAD`,
 * OLDEST-first, the order `git rebase -i` applies them) — reorder, per-row action,
 * and reword/squash messages. This module is the reducer for that list plus the
 * "fold squash/fixup under their leader" grouping the UI renders; it is react/monaco
 * -free so it is node:test-able and shared with the git-host todo serializer's shape.
 * The actual `git rebase -i` execution lives in main/ide/git-host.ts (transport).
 */

/** The subset of rebase todo actions this editor exposes (plan whitelist). */
export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

/** One editable todo row. `message` is only meaningful for reword/squash. */
export interface RebasePlanRow {
  sha: string;
  subject: string;
  action: RebaseAction;
  /** the reword/squash message the user typed (defaults to `subject` at run time). */
  message?: string;
}

/** reword/squash fire the commit-message editor; pick/fixup/drop never do. */
export function needsMessage(action: RebaseAction): boolean {
  return action === "reword" || action === "squash";
}

/** Move row `index` one slot up (`-1`) or down (`+1`); out-of-range is a no-op. */
export function moveRow(
  rows: readonly RebasePlanRow[],
  index: number,
  dir: -1 | 1,
): RebasePlanRow[] {
  const target = index + dir;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) {
    return [...rows];
  }
  const next = [...rows];
  const a = next[index];
  const b = next[target];
  if (!a || !b) return next;
  next[index] = b;
  next[target] = a;
  return next;
}

/** Set row `index`'s action (immutable; out-of-range is a no-op). */
export function setRowAction(
  rows: readonly RebasePlanRow[],
  index: number,
  action: RebaseAction,
): RebasePlanRow[] {
  return rows.map((r, i) => (i === index ? { ...r, action } : { ...r }));
}

/** Set row `index`'s reword/squash message (immutable; out-of-range is a no-op). */
export function setRowMessage(
  rows: readonly RebasePlanRow[],
  index: number,
  message: string,
): RebasePlanRow[] {
  return rows.map((r, i) => (i === index ? { ...r, message } : { ...r }));
}

/** A leader commit plus the squash/fixup rows that fold INTO it (visual grouping). */
export interface FoldGroup {
  leader: RebasePlanRow;
  /** the leader's index in the flat plan (so the UI can address it for edits). */
  leaderIndex: number;
  /** the squash/fixup rows folded under this leader, each with its own flat index. */
  folded: { row: RebasePlanRow; index: number }[];
}

/**
 * Group the plan for display: `drop` rows vanish; a `squash`/`fixup` row folds under
 * the nearest preceding non-dropped leader. A leading squash/fixup (no leader yet)
 * becomes its own leader so it stays visible — `validatePlan` flags that as invalid.
 */
export function foldPlan(rows: readonly RebasePlanRow[]): FoldGroup[] {
  const groups: FoldGroup[] = [];
  rows.forEach((row, index) => {
    if (row.action === "drop") return;
    const last = groups[groups.length - 1];
    if ((row.action === "squash" || row.action === "fixup") && last) {
      last.folded.push({ row, index });
    } else {
      groups.push({ leader: row, leaderIndex: index, folded: [] });
    }
  });
  return groups;
}

/**
 * Is this plan runnable? `git rebase -i` rejects a todo whose FIRST kept command is
 * squash/fixup ("cannot 'squash' without a previous commit"), and a plan that drops
 * every commit has nothing to apply.
 */
export function validatePlan(rows: readonly RebasePlanRow[]): { ok: boolean; error?: string } {
  const kept = rows.filter((r) => r.action !== "drop");
  if (kept.length === 0) return { ok: false, error: "every commit is dropped — nothing to apply" };
  const first = kept[0];
  if (first && (first.action === "squash" || first.action === "fixup")) {
    return { ok: false, error: `the first commit can't be "${first.action}"` };
  }
  return { ok: true };
}
