// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * drop-target.ts — what an OS drag-and-drop onto a window MEANS, decided in one pure place.
 *
 * The window's `will-navigate` hook is where a drop becomes visible to main: Chromium reports a
 * dropped file by trying to navigate the page to it. That hook lives in `index.ts`, which cannot
 * be imported without booting Electron — so the DECISION lives here instead, where it can be
 * tested against the real path guard rather than re-implemented in a test that would then be free
 * to drift from the shipped code.
 *
 * Two decisions, and the security of the feature is entirely in the second one:
 *
 *   - is this URL the app's OWN page (in-app routing) or something the user dropped?
 *   - and if it was dropped, what has the user actually authorised?
 *
 * A FOLDER is the drag-and-drop equivalent of File ▸ Open Folder and earns the same working-set
 * grant. A FILE earns a single-path approval and nothing more: dropping one file out of
 * `~/Downloads` must not put `~/Downloads` into the agent's write scope.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What main should do with a navigation the window tried to perform. */
export type DropDecision =
  /** the app's own page — let it navigate, this is in-app routing */
  | { kind: "app" }
  /** a dropped directory — grant it as a working-set root, then open it */
  | { kind: "folder"; path: string }
  /** a dropped file — approve that ONE path, then open it in the editor */
  | { kind: "file"; path: string }
  /** anything else — block the navigation and do nothing else */
  | { kind: "ignore" };

/** Resolve a path for comparison without throwing on one that does not exist. */
function canonicalish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The filesystem path a `file://` URL names, or null when it is not one. */
export function filePathFromUrl(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  const bare = url.split("#")[0]?.split("?")[0] ?? url;
  try {
    return fileURLToPath(bare);
  } catch {
    return null;
  }
}

/**
 * Is this URL the app's own renderer entry?
 *
 * The check it replaced was `url.startsWith("file://")`, which in a packaged build cannot tell the
 * app's own page from a file the user just dragged onto the window — both are `file://`. Dropping
 * anything therefore navigated the app AWAY to that file, replacing the whole UI and the session
 * with it. Hash and query are stripped so in-app routing (`#/editor`) still counts as the app.
 */
export function isOwnRendererUrl(url: string, entryPath: string): boolean {
  const p = filePathFromUrl(url);
  return p !== null && canonicalish(p) === canonicalish(entryPath);
}

/**
 * Decide what a navigation attempt is.
 *
 * `statPath` is injected so this stays pure and testable; production passes `statSync`. A path
 * that cannot be stat'd is `ignore` — a drop we cannot resolve is not worth surfacing as an error,
 * but it must never fall through to "navigate".
 */
export function classifyNavigation(
  url: string,
  entryPath: string,
  statPath: (p: string) => { isDirectory(): boolean; isFile(): boolean },
): DropDecision {
  if (isOwnRendererUrl(url, entryPath)) return { kind: "app" };
  const path = filePathFromUrl(url);
  if (path === null) return { kind: "ignore" };
  let st: { isDirectory(): boolean; isFile(): boolean };
  try {
    st = statPath(path);
  } catch {
    return { kind: "ignore" };
  }
  if (st.isDirectory()) return { kind: "folder", path };
  if (st.isFile()) return { kind: "file", path };
  return { kind: "ignore" };
}
