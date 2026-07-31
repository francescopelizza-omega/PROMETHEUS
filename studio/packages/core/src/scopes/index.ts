/**
 * scopes — file 13 §2.6: named file-glob Scopes (filter search/inspections/problems) +
 * Favorites + Bookmarks. Pure; glob matching reuses 07/09's globMatch.
 */
export type { Changelist } from "./changelists.js";
export {
  DEFAULT_CHANGELIST_ID,
  assignNewFiles,
  createList,
  defaultChangelist,
  deleteList,
  filesOf,
  moveFiles,
  reconcile,
  renameList,
  withDefault,
} from "./changelists.js";
export type { Bookmark, Favorite, Scope } from "./scopes.js";
export {
  BUILTIN_SCOPES,
  SCOPE_ALL,
  SCOPE_PRODUCTION,
  SCOPE_TESTS,
  bookmarkByMnemonic,
  filterByScope,
  isFavorite,
  matchScope,
  removeBookmark,
  setBookmark,
  toggleFavorite,
} from "./scopes.js";
