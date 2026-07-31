/**
 * ide/xterm-loader.ts — the LAZY @xterm/xterm loader (file 07 §6.1/§12).
 *
 * xterm.js backs the integrated terminal. Like Monaco it is loaded via a DYNAMIC
 * import() so the initial bundle stays small AND the build does not hard-fail when
 * @xterm/xterm is not yet installed in this env (the orchestrator installs the heavy
 * deps after this pass). The Terminal pane DEGRADES GRACEFULLY when xterm — or the
 * pty backend (node-pty, also absent here) — is unavailable (§6.1), so no real
 * terminal session is ever faked.
 *
 * Renderer-SANDBOXED (C5): @xterm/* are pure browser packages (no node/electron); the
 * PTY child process lives in MAIN (pty-host), reached over window.prometheus.ide.pty*.
 */

type XtermModule = typeof import("@xterm/xterm");
type FitAddonModule = typeof import("@xterm/addon-fit");

let xtermCache: XtermModule | null | undefined;
let fitCache: FitAddonModule | null | undefined;

/** Load (and memoise) the xterm module + the fit addon. Either may be null when absent. */
export async function loadXterm(): Promise<{
  xterm: XtermModule | null;
  fit: FitAddonModule | null;
}> {
  if (xtermCache === undefined) {
    try {
      xtermCache = (await import(/* @vite-ignore */ "@xterm/xterm")) as XtermModule;
    } catch {
      xtermCache = null;
    }
  }
  if (fitCache === undefined) {
    try {
      fitCache = (await import(/* @vite-ignore */ "@xterm/addon-fit")) as FitAddonModule;
    } catch {
      fitCache = null;
    }
  }
  return { xterm: xtermCache, fit: fitCache };
}

/** Whether xterm has been loaded successfully. */
export function xtermReady(): boolean {
  return xtermCache !== undefined && xtermCache !== null;
}

/** A loosely-typed xterm addon constructor (the optional addons aren't in the typecheck
 *  graph — they're declared optionalDependencies + loaded only when present). */
export type XtermAddonCtor = new (...args: unknown[]) => unknown;

let clipboardCache: XtermAddonCtor | null | undefined;

/**
 * Load (and memoise) the OSC-52 clipboard addon (`@xterm/addon-clipboard`) for native
 * copy/paste. Optional: returns null when absent (the terminal still works). The
 * specifier is cast to `string` so TS never demands the package be in the typecheck
 * graph — it is loaded at runtime only when the build installed it.
 */
export async function loadClipboardAddon(): Promise<XtermAddonCtor | null> {
  if (clipboardCache === undefined) {
    try {
      const spec = "@xterm/addon-clipboard" as string;
      const m = (await import(/* @vite-ignore */ spec)) as { ClipboardAddon?: XtermAddonCtor };
      clipboardCache = m.ClipboardAddon ?? null;
    } catch {
      clipboardCache = null;
    }
  }
  return clipboardCache;
}

let searchCache: XtermAddonCtor | null | undefined;

/**
 * Load (and memoise) the search addon (`@xterm/addon-search`) for the find-box (APP-091).
 * OPTIONAL — it is NOT in package.json (no new dep this task); returns null when absent, and
 * Terminal.tsx falls back to a pure buffer-walk (terminal-view.searchLines). The specifier is
 * cast to `string` so TS never demands the package be in the typecheck graph.
 */
export async function loadSearchAddon(): Promise<XtermAddonCtor | null> {
  if (searchCache === undefined) {
    try {
      const spec = "@xterm/addon-search" as string;
      const m = (await import(/* @vite-ignore */ spec)) as { SearchAddon?: XtermAddonCtor };
      searchCache = m.SearchAddon ?? null;
    } catch {
      searchCache = null;
    }
  }
  return searchCache;
}

let ligaturesCache: XtermAddonCtor | null | undefined;

/**
 * Load (and memoise) the programming-ligatures addon (`@xterm/addon-ligatures`)
 * so the terminal can render `=>`/`!=`/`>=` as ligatures when the user enables it
 * for a ligature-capable family (JetBrains Mono / Fira Code / Cascadia Code),
 * matching PyCharm's terminal. Optional: returns null when absent, and the caller
 * also guards `activate()` in a try/catch — if the addon can't run in this sandbox
 * the terminal simply renders without ligatures (never faked).
 */
export async function loadLigaturesAddon(): Promise<XtermAddonCtor | null> {
  if (ligaturesCache === undefined) {
    try {
      const spec = "@xterm/addon-ligatures" as string;
      const m = (await import(/* @vite-ignore */ spec)) as { LigaturesAddon?: XtermAddonCtor };
      ligaturesCache = m.LigaturesAddon ?? null;
    } catch {
      ligaturesCache = null;
    }
  }
  return ligaturesCache;
}
