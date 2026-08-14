import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * esbuild.mjs — bundle the extension (and its integration-test suite) to CommonJS.
 *
 * WHY A BUNDLER IS REQUIRED HERE, not a convenience:
 *
 *   `@prometheus/core` is ESM-only (`"type": "module"`, `exports` with `import` conditions
 *   only). The VS Code extension host loads an extension's `main` through a CommonJS `require`.
 *   A CJS `require` of an ESM-only package throws ERR_REQUIRE_ESM, so `tsc`-emitted output
 *   cannot be loaded by VS Code no matter which module setting it is given. esbuild resolves
 *   core's `import` condition, inlines it, and emits one self-contained CJS file — which also
 *   means the shipped .vsix carries no `node_modules` and `vsce package --no-dependencies` is
 *   correct rather than a shortcut.
 *
 *   `vscode` itself is EXTERNAL: it is not a package, it is a module the extension host injects
 *   at require time. Bundling it would be impossible (it does not exist on disk) and pointless.
 *
 * The test suite is bundled the same way and for the same reason — the specs import both
 * `vscode` and `@prometheus/core`.
 */
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const shared = {
  bundle: true,
  platform: "node",
  // The VS Code extension host runs a recent Electron/Node; ES2022 is safely within it and
  // matches the workspace's own tsconfig target.
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
  /**
   * Give `import.meta.url` a correct CJS value.
   *
   * `@prometheus/core`'s provider registry does `dirname(fileURLToPath(import.meta.url))` at
   * MODULE TOP LEVEL. esbuild's cjs output otherwise substitutes an empty string there, and
   * `fileURLToPath("")` throws `ERR_INVALID_URL_SCHEME` — at require time, which means the
   * extension would fail to activate with a stack trace pointing into a dependency. Defining it
   * as the real file URL of the bundle keeps that code doing what it does under ESM.
   */
  banner: {
    js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "__importMetaUrl" },
};

const targets = [
  {
    ...shared,
    entryPoints: [join(here, "src", "extension.ts")],
    outfile: join(here, "out", "extension.cjs"),
    // Minified only for the shipped extension; the test bundle keeps names so a stack trace
    // out of the extension host is readable.
    minify: !watch,
  },
  {
    ...shared,
    entryPoints: [join(here, "src", "test", "suite", "index.ts")],
    outfile: join(here, "out", "test", "suite", "index.cjs"),
  },
];

for (const t of targets) {
  await build(t);
}
console.log("built extension + test suite → out/");
