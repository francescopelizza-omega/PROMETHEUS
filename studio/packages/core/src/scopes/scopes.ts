/**
 * scopes/scopes.ts — Scopes & Favorites (file 13 §2.6).
 *
 * A `Scope` is a named set of file globs that filters search / inspections / problems
 * (e.g. "Production" excludes tests). Favorites = pinned files; Bookmarks = lines with
 * optional mnemonics. Pure: glob matching reuses 07/09's `globMatch`/`isPathAllowed`
 * (no external glob lib in core). Persistence is the caller's.
 */
import { globMatch, isPathAllowed } from "../agents/sandbox.js";

/** A named file-glob filter (§2.6). */
export interface Scope {
  id: string;
  name: string;
  include: string[]; // globs a path must match to be IN scope
  exclude?: string[]; // globs that drop a path back OUT of scope
  builtin?: boolean;
}

/** "Project Files" — everything. */
export const SCOPE_ALL: Scope = {
  id: "all",
  name: "Project Files",
  include: ["**/*"],
  builtin: true,
};

/** "Production" — excludes tests (§2.6 example). */
export const SCOPE_PRODUCTION: Scope = {
  id: "production",
  name: "Production",
  include: ["**/*"],
  exclude: [
    "**/test_*",
    "**/*_test.*",
    "**/tests/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
  ],
  builtin: true,
};

/** "Tests" — only test files. */
export const SCOPE_TESTS: Scope = {
  id: "tests",
  name: "Tests",
  include: [
    "**/test_*",
    "**/*_test.*",
    "**/tests/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
  ],
  builtin: true,
};

export const BUILTIN_SCOPES: readonly Scope[] = Object.freeze([
  SCOPE_ALL,
  SCOPE_PRODUCTION,
  SCOPE_TESTS,
]);

/** True when `path` (relative to `root`) is IN scope: included AND not excluded. */
export function matchScope(scope: Scope, path: string, root = ""): boolean {
  const included = isPathAllowed(path, scope.include, root);
  if (!included) return false;
  if (scope.exclude && scope.exclude.length > 0) {
    return !scope.exclude.some((g) => globMatch(g, path));
  }
  return true;
}

/** Filter a list of paths to those in scope (§2.6). */
export function filterByScope(paths: readonly string[], scope: Scope, root = ""): string[] {
  return paths.filter((p) => matchScope(scope, p, root));
}

/* ── Favorites & Bookmarks (§2.6) ──────────────────────────────────────────── */

/** A pinned file (§2.6). */
export interface Favorite {
  path: string;
  label?: string;
}

/** A bookmarked line, optionally with a mnemonic (§2.6). */
export interface Bookmark {
  path: string;
  line: number;
  mnemonic?: string; // 0-9 / a-z quick-jump key
  note?: string;
}

/** Toggle a favorite (add if absent, remove if present) — returns a NEW list. */
export function toggleFavorite(
  favorites: readonly Favorite[],
  path: string,
  label?: string,
): Favorite[] {
  const exists = favorites.some((f) => f.path === path);
  if (exists) return favorites.filter((f) => f.path !== path);
  return [...favorites, { path, ...(label ? { label } : {}) }];
}

/** Whether a path is favorited. */
export function isFavorite(favorites: readonly Favorite[], path: string): boolean {
  return favorites.some((f) => f.path === path);
}

/** Add or replace a bookmark at (path, line) — returns a NEW list. */
export function setBookmark(bookmarks: readonly Bookmark[], bookmark: Bookmark): Bookmark[] {
  const without = bookmarks.filter((b) => !(b.path === bookmark.path && b.line === bookmark.line));
  return [...without, bookmark];
}

/** Remove a bookmark at (path, line) — returns a NEW list. */
export function removeBookmark(
  bookmarks: readonly Bookmark[],
  path: string,
  line: number,
): Bookmark[] {
  return bookmarks.filter((b) => !(b.path === path && b.line === line));
}

/** Look up a bookmark by its mnemonic (quick-jump). */
export function bookmarkByMnemonic(
  bookmarks: readonly Bookmark[],
  mnemonic: string,
): Bookmark | undefined {
  return bookmarks.find((b) => b.mnemonic === mnemonic);
}
