/**
 * electron.vite.config.ts — the electron-vite build for the three processes.
 *
 * electron-vite splits the build into MAIN, PRELOAD, and RENDERER targets, each
 * with its own Rollup input + externals:
 *   - main    : node platform; bundles @prometheus/engine-bridge + core (the only
 *               place they're allowed); externalises `electron` + node built-ins.
 *   - preload : node platform; the contextBridge wire; externalises `electron`.
 *   - renderer: browser platform; React + @prometheus/ui ONLY. engine-bridge /
 *               core / node:* are NEVER bundled here (C5) — they're not imported.
 *
 * The `@prometheus/*` bare specifiers resolve to each package's src entry via the
 * aliases below (matching the root tsconfig paths) so a plain dev build works
 * without a prior package publish.
 *
 * NOTE: `electron-vite`, `vite`, `electron`, `@vitejs/plugin-react` are declared
 * in needsDeps and are NOT installed this pass — this config is source-only and
 * will build once the toolchain lands (C10: Electron 33 / Vite, React 19).
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const ROOT = resolve(__dirname, "..", "..");
const require = createRequire(import.meta.url);

/**
 * `@prometheus/core` SUBPATH aliases → the TS source each one maps to.
 *
 * Every subpath must be listed. Vite matches alias entries in ORDER and a bare
 * `@prometheus/core` prefix match rewrites `@prometheus/core/ai-effort` to
 * `…/src/index.ts/ai-effort` — which fails the build with a confusing `ENOTDIR: not a
 * directory`. So these MUST precede the bare entry below, and adding a subpath to
 * `packages/core/package.json` without adding it here breaks the desktop build the moment
 * main or the renderer imports it.
 */
const CORE_SUBPATHS: Record<string, string> = {
  "@prometheus/core/mcp-node": "packages/core/src/mcp/host/node.ts",
  "@prometheus/core/agent-authorization": "packages/core/src/agent/authorization.ts",
  "@prometheus/core/agent-files": "packages/core/src/agent/agent-files.ts",
  "@prometheus/core/agent-hooks": "packages/core/src/agent/hooks.ts",
  "@prometheus/core/command-loader": "packages/core/src/commands/loader.ts",
  "@prometheus/core/command-gate": "packages/core/src/commands/gate.ts",
  "@prometheus/core/agent-checkpoint": "packages/core/src/agent/checkpoint.ts",
  "@prometheus/core/agent-events": "packages/core/src/agent/events.ts",
  "@prometheus/core/agent-exec": "packages/core/src/agent/exec/index.ts",
  "@prometheus/core/agent-loop": "packages/core/src/agent/loop.ts",
  "@prometheus/core/agent-protocol": "packages/core/src/agent/protocol/index.ts",
  "@prometheus/core/agent-session": "packages/core/src/agent/session-store.ts",
  // ORDER IS LOAD-BEARING: vite matches a string alias by PREFIX, and
  // `@prometheus/core/agent-system` is a prefix of `@prometheus/core/agent-system-host`.
  // With the shorter one first, the host specifier rewrites to `…/system/index.ts-host`.
  "@prometheus/core/agent-system-host": "packages/core/src/agent/system/host/index.ts",
  "@prometheus/core/agent-system": "packages/core/src/agent/system/index.ts",
  "@prometheus/core/agent-tools": "packages/core/src/agent/tools.ts",
  "@prometheus/core/agent-patch": "packages/core/src/agent/patch.ts",
  "@prometheus/core/agent-compact": "packages/core/src/agent/compact.ts",
  "@prometheus/core/agent-todo": "packages/core/src/agent/todo.ts",
  "@prometheus/core/agent-subagent": "packages/core/src/agent/subagent.ts",
  "@prometheus/core/agent-question": "packages/core/src/agent/question.ts",
  "@prometheus/core/agent-permissions": "packages/core/src/agent/permissions.ts",
  "@prometheus/core/agent-permission-modes": "packages/core/src/agent/permission-modes.ts",
  "@prometheus/core/ai-retry": "packages/core/src/ai/retry-index.ts",
  "@prometheus/core/ai-effort": "packages/core/src/ai/effort/index.ts",
  "@prometheus/core/commands": "packages/core/src/commands.ts",
  "@prometheus/core/editor": "packages/core/src/editor/index.ts",
  "@prometheus/core/format": "packages/core/src/format/index.ts",
  "@prometheus/core/git-worktree": "packages/core/src/git/worktree.ts",
  "@prometheus/core/keymap": "packages/core/src/settings/keymap.ts",
  "@prometheus/core/memory": "packages/core/src/memory/index.ts",
  "@prometheus/core/migrations": "packages/core/src/migrations/index.ts",
  "@prometheus/core/rules": "packages/core/src/rules/index.ts",
  "@prometheus/core/templates": "packages/core/src/templates/live.ts",
  "@prometheus/core/token-economy": "packages/core/src/token-economy/index.ts",
};

/** Workspace package aliases → each package's TS source entry (subpaths FIRST, see above). */
const alias = {
  "@prometheus/engine-bridge": resolve(ROOT, "packages/engine-bridge/src/index.ts"),
  ...Object.fromEntries(
    Object.entries(CORE_SUBPATHS).map(([spec, rel]) => [spec, resolve(ROOT, rel)]),
  ),
  "@prometheus/core": resolve(ROOT, "packages/core/src/index.ts"),
  "@prometheus/ui": resolve(ROOT, "packages/ui/src/index.ts"),
};

/**
 * The heavy renderer deps the IDE surface loads via DYNAMIC import (file 07 §3/§6/§12):
 * Monaco + xterm. They are DECLARED in package.json but installed by the orchestrator
 * AFTER this pass. So we BUNDLE them when present (the renderer module count jumps with
 * Monaco, §12) and mark them EXTERNAL when absent so this source-only build still
 * SUCCEEDS. A dep is "present" iff it resolves from the desktop package.
 */
const HEAVY_RENDERER_DEPS = ["monaco-editor", "@xterm/xterm", "@xterm/addon-fit"] as const;

function resolvable(spec: string): boolean {
  // `require.resolve(spec)` fails for ESM-only packages with no CJS main (e.g.
  // monaco-editor), so probe the package.json — and fall back to a filesystem check
  // of the (pnpm-symlinked) node_modules entry under the desktop package.
  try {
    require.resolve(`${spec}/package.json`);
    return true;
  } catch {
    /* fall through */
  }
  return existsSync(resolve(__dirname, "node_modules", spec, "package.json"));
}

/** The heavy deps NOT yet installed → externalised so the build doesn't fail to resolve. */
const rendererExternal = HEAVY_RENDERER_DEPS.filter((d) => !resolvable(d));

/**
 * Tailwind/PostCSS wiring (file 08 §6/§3). The renderer's styles/global.css pulls
 * @prometheus/ui tokens.css + `@tailwind base/components/utilities`; postcss.config.cjs
 * runs tailwindcss + autoprefixer to compile the token-mapped utility layer.
 *
 * tailwindcss + autoprefixer are DECLARED in package.json but installed by the
 * orchestrator AFTER this pass. PostCSS would THROW if it loaded a config naming a
 * missing plugin — so we point Vite at the postcss config ONLY when tailwindcss is
 * resolvable. Until then the @tailwind at-rules pass through as inert CSS (Vite's
 * default CSS handling leaves unknown at-rules alone) and the source-only build
 * stays green; once Tailwind lands, the same config compiles a utilities chunk.
 */
const tailwindReady = resolvable("tailwindcss") && resolvable("autoprefixer");
const rendererCss = tailwindReady ? { postcss: __dirname } : undefined;

/**
 * DEV-ONLY CSP relax (serve mode). renderer/index.html ships a STRICT <meta> CSP
 * (`script-src 'self'`) for production. But in dev, `@vitejs/plugin-react` injects
 * an INLINE `@react-refresh` preamble <script> and Vite runs HMR over a WebSocket.
 * Under the strict policy the inline preamble is CSP-REFUSED, plugin-react then
 * throws "@vitejs/plugin-react can't detect preamble", React never mounts, and the
 * window paints only the dark body bg — a BLACK WINDOW with no UI.
 *
 * This plugin rewrites ONLY the <meta> CSP, ONLY while serving (dev), to additionally
 * allow the inline preamble + eval + the localhost HMR socket. `apply: "serve"` means
 * the BUILT app keeps the strict meta verbatim — production security is unchanged.
 * (The MAIN-process response-header CSP is relaxed in dev the same way; CSP enforces
 * the INTERSECTION of meta + header, so BOTH must allow the preamble in dev.)
 */
function devCspRelax() {
  const DEV_CSP =
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' ws: wss: http://localhost:*; " +
    "worker-src 'self' blob:; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  return {
    name: "prometheus:dev-csp-relax",
    apply: "serve" as const,
    transformIndexHtml(html: string) {
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i,
        `$1${DEV_CSP}$2`,
      );
    },
  };
}

export default defineConfig({
  main: {
    // Bundle our workspace packages into the main bundle; externalise node + electron.
    plugins: [
      externalizeDepsPlugin({ exclude: ["@prometheus/engine-bridge", "@prometheus/core"] }),
    ],
    resolve: { alias },
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // The offloaded WORKER entry (file 01 §5). Built alongside main (→
          // out/main/worker.js) so the utilityProcess can fork it from the same
          // dir. Rollup forbids a relative `[name]` escaping outDir, so the worker
          // lives beside main rather than in a sibling out/worker/. It bundles only
          // the pure task logic (worker/tasks.ts) — no electron, no engine-bridge.
          worker: resolve(__dirname, "src/worker/index.ts"),
          // The EXTENSION-runner entry (file 09 §5, APP-059). Built beside main (→
          // out/main/extRunner.js) so utilityProcess.fork can load it from the same dir,
          // exactly like worker.js. Extensions run in THIS process — never main/renderer.
          extRunner: resolve(__dirname, "src/ext-runner/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        // A sandboxed Electron preload must be CommonJS; emit `.cjs` so it is
        // unambiguous CJS even though the package is `type: module`.
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    // Renderer gets ONLY the design-system alias; engine-bridge/core are absent
    // here by construction (the renderer never imports them — C5).
    resolve: {
      alias: { "@prometheus/ui": alias["@prometheus/ui"] },
    },
    // react() = JSX/Fast-Refresh. devCspRelax() rewrites the index.html <meta> CSP
    // in dev so Vite's inline @react-refresh preamble isn't CSP-blocked (black-window
    // fix); it is a no-op in `build` (production keeps the strict meta).
    plugins: [react(), devCspRelax()],
    // Tailwind/PostCSS compiles the @tailwind utility layer in styles/global.css —
    // wired ONLY when tailwindcss is installed so the source-only build stays green
    // before the dep lands (file 08 §6; see `rendererCss` above).
    ...(rendererCss ? { css: rendererCss } : {}),
    // Monaco ships web workers (TS/JSON/CSS/editor); when monaco-editor is installed it
    // is pre-bundled so the worker chunks are emitted. The CSP (renderer/index.html)
    // must allow `worker-src blob:` for Monaco's workers (§12) — kept in the index.html
    // policy. Until Monaco is installed, optimizeDeps simply has nothing extra to do.
    optimizeDeps: {
      include: resolvable("monaco-editor") ? ["monaco-editor"] : [],
    },
    build: {
      outDir: resolve(__dirname, "out/renderer"),
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          // APP-090: the tear-out terminal window's own HTML entry (a second renderer page,
          // mirroring the main-process `worker`/`extRunner` multi-input). electron-vite
          // requires each renderer entry be an `.html` with its own <script type=module>.
          floatingTerminal: resolve(__dirname, "src/renderer/floating-terminal.html"),
        },
        // BUNDLE Monaco + xterm when installed; EXTERNALISE them when not (this pass)
        // so the source-only build SUCCEEDS without the heavy deps (§12). Once the
        // orchestrator installs them, `rendererExternal` is empty → they are bundled
        // and the renderer module count jumps with Monaco, as the brief expects.
        external: rendererExternal,
      },
    },
  },
});
