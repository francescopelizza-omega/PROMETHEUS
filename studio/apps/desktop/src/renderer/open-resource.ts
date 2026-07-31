/**
 * renderer/open-resource.ts — the one place any surface asks the app to OPEN a thing.
 *
 * Three open behaviors (the user's model):
 *   - a FILE  → open it inside Prometheus's editor (a new tab),
 *   - a FOLDER → open it as the editor workspace (its contents shown in the tree),
 *   - SOFTWARE/anything else → open it with the OS default handler, OUTSIDE the app
 *     (the same as a Finder/Explorer double-click), via the `openPath` bridge seam.
 *
 * File + folder go through window CustomEvents that App.tsx listens for (so a deep
 * leaf component never needs the App's navigation/store wiring); external open is a
 * direct bridge call. Renderer-SANDBOXED (C5): events + window.prometheus only.
 */

export const OPEN_FILE_EVENT = "prometheus:open-file";
export const OPEN_FOLDER_EVENT = "prometheus:open-folder";

/** Open a file in the Prometheus editor (navigates to the Editor activity). */
export function openFileInEditor(path: string): void {
  if (!path) return;
  window.dispatchEvent(new CustomEvent(OPEN_FILE_EVENT, { detail: { path } }));
}

/** Open a folder as the editor workspace (its tree is shown inside Prometheus). */
export function openFolderInWorkspace(path: string): void {
  if (!path) return;
  window.dispatchEvent(new CustomEvent(OPEN_FOLDER_EVENT, { detail: { path } }));
}

/** Open a path with the OS default handler, OUTSIDE Prometheus (software/app/doc). */
export function openExternally(path: string): void {
  if (!path) return;
  void window.prometheus?.openPath?.(path).catch(() => {
    /* the OS refused / no handler — non-fatal, the caller stays put */
  });
}
