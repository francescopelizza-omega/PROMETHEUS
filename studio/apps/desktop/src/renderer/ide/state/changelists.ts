/**
 * ide/state/changelists.ts — the renderer-local MIRROR of the pure changelist
 * reducers (APP-038).
 *
 * The SANDBOXED renderer (C5) does not import core's runtime, so — exactly like
 * diff-review-state mirrors core's ChangeSet — this duplicates the tiny pure module
 * `@prometheus/core` scopes/changelists.ts with IDENTICAL shapes. The core copy is
 * the tested source of truth (changelists.test.ts); keep the two byte-for-byte in
 * lockstep. No react/engine/fs here — persistence lives in changelist-store.ts.
 */

/** The id of the undeletable Default list (the sink for unassigned changes). */
export const DEFAULT_CHANGELIST_ID = "default";

/** A named set of repo-relative changed-file paths (forward-slashed, git-relative). */
export interface Changelist {
  id: string;
  name: string;
  isDefault: boolean;
  files: string[];
}

/** A fresh, empty Default list. */
export function defaultChangelist(): Changelist {
  return { id: DEFAULT_CHANGELIST_ID, name: "Changes", isDefault: true, files: [] };
}

function uniq(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** Guarantee a Default list exists (prepended if absent) — returns a NEW array. */
export function withDefault(lists: readonly Changelist[]): Changelist[] {
  return lists.some((l) => l.isDefault) ? [...lists] : [defaultChangelist(), ...lists];
}

/** Create a named list. NO-OP (same array) on empty/whitespace or a duplicate name. */
export function createList(lists: readonly Changelist[], name: string, id: string): Changelist[] {
  const trimmed = name.trim();
  if (!trimmed || lists.some((l) => l.name === trimmed)) return lists as Changelist[];
  return [...lists, { id, name: trimmed, isDefault: false, files: [] }];
}

/** Rename a list. NO-OP on an empty name or a collision with a DIFFERENT list. */
export function renameList(lists: readonly Changelist[], id: string, name: string): Changelist[] {
  const trimmed = name.trim();
  if (!trimmed || lists.some((l) => l.id !== id && l.name === trimmed)) {
    return lists as Changelist[];
  }
  return lists.map((l) => (l.id === id ? { ...l, name: trimmed } : l));
}

/** Delete a list; members reassign to Default. Deleting Default/unknown is a NO-OP. */
export function deleteList(lists: readonly Changelist[], id: string): Changelist[] {
  const target = lists.find((l) => l.id === id);
  if (!target || target.isDefault) return lists as Changelist[];
  const orphaned = target.files;
  return lists
    .filter((l) => l.id !== id)
    .map((l) => (l.isDefault ? { ...l, files: uniq([...l.files, ...orphaned]) } : l));
}

/** Move `files` INTO list `toId`, removing them from every other list. */
export function moveFiles(
  lists: readonly Changelist[],
  toId: string,
  files: readonly string[],
): Changelist[] {
  const moving = new Set(files);
  return lists.map((l) =>
    l.id === toId
      ? { ...l, files: uniq([...l.files, ...files]) }
      : { ...l, files: l.files.filter((f) => !moving.has(f)) },
  );
}

/** Sink status files not yet in ANY list into Default (ensuring a Default exists). */
export function assignNewFiles(
  lists: readonly Changelist[],
  currentFiles: readonly string[],
): Changelist[] {
  const base = withDefault(lists);
  const known = new Set(base.flatMap((l) => l.files));
  const fresh = currentFiles.filter((f) => !known.has(f));
  if (fresh.length === 0) return base;
  return base.map((l) => (l.isDefault ? { ...l, files: uniq([...l.files, ...fresh]) } : l));
}

/** Drop list members no longer present in git status (committed/reverted/deleted). */
export function reconcile(
  lists: readonly Changelist[],
  currentFiles: readonly string[],
): Changelist[] {
  const present = new Set(currentFiles);
  return lists.map((l) => ({ ...l, files: l.files.filter((f) => present.has(f)) }));
}

/** The files of the list `id`, or [] if unknown. */
export function filesOf(lists: readonly Changelist[], id: string): string[] {
  return lists.find((l) => l.id === id)?.files ?? [];
}
