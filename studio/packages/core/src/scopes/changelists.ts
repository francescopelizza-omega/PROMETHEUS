/**
 * scopes/changelists.ts — JetBrains-style Changelists (APP-038).
 *
 * A `Changelist` is a NAMED set of repo-relative changed-file paths. git has no
 * native changelist concept, so this is pure client-side bookkeeping over the paths
 * `git status` reports: the panel groups files into lists, commits one list at a
 * time, and moves files between lists. The always-present Default list is the sink
 * for new/unknown changes and cannot be deleted.
 *
 * Every reducer is PURE and TOTAL and returns a NEW list (never mutates input) —
 * mirroring scopes.ts. An invalid op (empty/duplicate name, deleting Default)
 * returns the SAME array reference, so a caller can detect a no-op by identity.
 * Persistence + the actual git staging are the caller's (renderer + git-host).
 */

/** The id of the undeletable Default list (the sink for unassigned changes). */
export const DEFAULT_CHANGELIST_ID = "default";

/** A named set of repo-relative changed-file paths (forward-slashed, git-relative). */
export interface Changelist {
  id: string;
  name: string;
  /** the Default list catches unassigned changes and is undeletable. */
  isDefault: boolean;
  files: string[];
}

/** A fresh, empty Default list. */
export function defaultChangelist(): Changelist {
  return { id: DEFAULT_CHANGELIST_ID, name: "Changes", isDefault: true, files: [] };
}

/** De-dupe preserving first-occurrence order. */
function uniq(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** Guarantee a Default list exists (prepended if absent) — returns a NEW array. */
export function withDefault(lists: readonly Changelist[]): Changelist[] {
  return lists.some((l) => l.isDefault) ? [...lists] : [defaultChangelist(), ...lists];
}

/**
 * Create a named list. NO-OP (returns the same array) on an empty or whitespace
 * name, or a name that collides (case-sensitive) with an existing list.
 */
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

/**
 * Delete a list; its members are reassigned to Default. Deleting the Default list
 * (or an unknown id) is a NO-OP (returns the same array).
 */
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

/**
 * Assign status files not yet in ANY list to the Default list (the sink for new /
 * unknown changes). Ensures a Default exists first.
 */
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

/**
 * Stale-entry hygiene: drop list members no longer present in git status (a file
 * committed elsewhere, reverted, or deleted). PURE — unit-testable without git.
 */
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
