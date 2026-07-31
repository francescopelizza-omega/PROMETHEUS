/**
 * ide/monaco-loader.ts — the LAZY monaco-editor loader (file 07 §3/§12).
 *
 * Monaco is a heavy dependency (the renderer module count jumps with it, §12). We
 * load it via a DYNAMIC import() so:
 *   1. the renderer's INITIAL bundle stays small (Monaco arrives on first editor use),
 *   2. the build does not hard-fail if monaco-editor is not yet installed in this
 *      env (the orchestrator installs the heavy deps after this pass — the import is
 *      resolved at runtime, behind a try/catch, so the build graph never *requires*
 *      it statically). Once installed, the dynamic chunk is emitted + Monaco's web
 *      workers are wired in electron.vite.config.ts (§12).
 *
 * `loadMonaco()` memoises the module so every pane shares ONE monaco namespace (the
 * §3.1 "one editor per group + shared ITextModel" model requires a single instance).
 * It returns null when Monaco is unavailable so callers render a graceful fallback —
 * NEVER a crash, mirroring the "degrades gracefully when no pty backend" rule for the
 * terminal.
 *
 * Renderer-SANDBOXED (C5): monaco-editor is a pure browser package (no node/electron).
 */

// The monaco-editor module type (type-only; erased — no runtime dep on the types pkg).
type MonacoModule = typeof import("monaco-editor");

let cached: MonacoModule | null | undefined;
let inflight: Promise<MonacoModule | null> | undefined;

/**
 * Load (and memoise) the monaco-editor module. Resolves to the module, or `null`
 * when it cannot be loaded (not installed / failed import) so the caller degrades
 * gracefully. Concurrent callers share one in-flight import.
 */
export async function loadMonaco(): Promise<MonacoModule | null> {
  if (cached !== undefined) return cached;
  if (inflight) return inflight;
  inflight = (async (): Promise<MonacoModule | null> => {
    try {
      // The `@vite-ignore` keeps Vite from trying to pre-bundle/resolve this at build
      // time when the package is absent; it is resolved at runtime once installed.
      const mod = (await import(/* @vite-ignore */ "monaco-editor")) as MonacoModule;
      cached = mod;
      return mod;
    } catch {
      cached = null;
      return null;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** Whether Monaco has been loaded successfully (sync check after a `loadMonaco`). */
export function monacoReady(): boolean {
  return cached !== undefined && cached !== null;
}
