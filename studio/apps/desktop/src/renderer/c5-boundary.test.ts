/**
 * c5-boundary.test.ts — the renderer may not reach the filesystem or the engine (C5).
 *
 * This is a SOURCE scan, not a build: the violation it guards was invisible to `tsc` (the types
 * resolve fine), invisible to `node:test` (nothing imports the renderer graph there), and only
 * surfaced as a rollup error from a THIRD package —
 *
 *   "existsSync" is not exported by "__vite-browser-external",
 *   imported by "packages/engine-bridge/dist/config.js"
 *
 * — with no mention of the renderer file that caused it. And even that only appeared once an
 * unrelated main-process build failure ahead of it was fixed, so the desktop app could not be
 * packaged at all while every test suite stayed green.
 *
 * The rule: renderer-side code talks to main over IPC. It may import PURE core subpaths
 * (`@prometheus/core/ai-effort`, `@prometheus/core/agent-schedule`, …) — never the bare
 * `@prometheus/core` barrel, which re-exports the MCP node host and the engine bridge, and never
 * `@prometheus/engine-bridge` itself. `import type` is exempt: it is erased before bundling.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_SRC = join(HERE, "..");
const STUDIO = join(DESKTOP_SRC, "..", "..", "..");

/** Everything bundled into the RENDERER target (electron.vite.config.ts → renderer.root + its
 *  imports). `routes/` and `shared/` are renderer-side despite living outside `renderer/`. */
const RENDERER_DIRS = ["renderer", "routes", "shared"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * Non-type imports of `spec` in `src`. `import type …` and `import { type X }` are erased by
 * the compiler and never reach the bundler, so only a bare value import is a violation.
 */
function valueImports(src: string, spec: string): string[] {
  const hits: string[] = [];
  const re = new RegExp(String.raw`^import\s+([\s\S]*?)from\s*["']${spec}["']`, "gm");
  for (const m of src.matchAll(re)) {
    const clause = (m[1] ?? "").trim();
    if (clause.startsWith("type ")) continue; // `import type { … } from`
    // a braces-only clause whose every specifier is `type X` is erased too
    const inner = clause.match(/^\{([\s\S]*)\}$/);
    if (inner) {
      const names = (inner[1] ?? "")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue;
    }
    hits.push(m[0].split("\n")[0] ?? m[0]);
  }
  return hits;
}

test("the renderer never VALUE-imports the engine bridge or the node-heavy core barrel", () => {
  const offenders: string[] = [];
  for (const d of RENDERER_DIRS) {
    for (const file of walk(join(DESKTOP_SRC, d))) {
      const src = readFileSync(file, "utf8");
      for (const spec of ["@prometheus/engine-bridge", "@prometheus/core"]) {
        for (const line of valueImports(src, spec)) {
          offenders.push(`${relative(STUDIO, file)}: ${line}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `renderer-side code must use a PURE core subpath (or IPC), never the barrel:\n${offenders.join("\n")}`,
  );
});

test("the renderer never imports a node built-in", () => {
  const offenders: string[] = [];
  for (const d of RENDERER_DIRS) {
    for (const file of walk(join(DESKTOP_SRC, d))) {
      const src = readFileSync(file, "utf8");
      if (/^import\s[\s\S]*?from\s*["']node:/m.test(src)) offenders.push(relative(STUDIO, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("`@prometheus/core/commands` stays browser-importable — the desktop help browser renders it", () => {
  /**
   * `routes/docs.tsx` imports `COMMAND_SPECS` as DATA. The registry reaches the engine through
   * `RouterContext.client`, so its engine-bridge imports must all be types; one value import
   * (`rawEngine`, for an `inventory` workaround the engine has since made unnecessary) was
   * enough to drag `node:fs` into the renderer bundle.
   */
  const src = readFileSync(join(STUDIO, "packages", "core", "src", "commands.ts"), "utf8");
  assert.deepEqual(valueImports(src, "@prometheus/engine-bridge"), []);
});
