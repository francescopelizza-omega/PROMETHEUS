/**
 * dev-resolver.test.ts — every core subpath the CLI can import resolves to SOURCE under test.
 *
 * `dev-resolver.mjs` maps bare `@prometheus` specifiers to the TypeScript sources under
 * `packages`, so `node --test` runs the code under edit. A subpath MISSING from the map does
 * not fail —
 * it falls through to node's own resolution, hits `packages/core/package.json` `exports`, and
 * loads `dist/`. The suite then exercises the last BUILT output.
 *
 * That is not hypothetical. `@prometheus/core/agent-system-host` was absent, so a fix to
 * `isPathAllowed` appeared to do nothing: the test kept failing against stale dist while the
 * source was already correct. The reverse is worse and quieter — a stale dist can keep a
 * suite GREEN across a real source regression.
 *
 * This is the third resolution path in this repo with its own drift risk, alongside vite's
 * `CORE_SUBPATHS` (guarded by `apps/desktop/src/build-aliases.test.ts`) and package.json
 * `exports` itself. Same failure mode, same remedy: assert it, do not remember it.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = dirname(HERE);
const ROOT = dirname(dirname(CLI));

/** The `@prometheus/core/*` specifiers the CLI's own source actually imports. */
function importedCoreSubpaths(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      for (const m of readFileSync(p, "utf8").matchAll(
        /["'](@prometheus\/core\/[a-z0-9-]+)["']/gi,
      )) {
        out.add(m[1] as string);
      }
    }
  };
  walk(join(CLI, "src"));
  return out;
}

/** The specifiers `dev-resolver.mjs` maps to source. */
function mappedSpecifiers(): Set<string> {
  const src = readFileSync(join(CLI, "dev-resolver.mjs"), "utf8");
  return new Set(
    [...src.matchAll(/["'](@prometheus\/core\/[a-z0-9-]+)["']\s*:/gi)].map((m) => m[1] as string),
  );
}

test("every core subpath the CLI imports is mapped to SOURCE by the dev resolver", () => {
  const mapped = mappedSpecifiers();
  const missing = [...importedCoreSubpaths()].filter((s) => !mapped.has(s)).sort();
  assert.deepEqual(
    missing,
    [],
    "these subpaths fall through to dist/ under `node --test`, so the suite runs BUILT code " +
      "instead of the source being edited — add them to MAP in apps/cli/dev-resolver.mjs",
  );
});

test("every mapped path points at a file that exists", () => {
  // A typo'd map entry is worse than a missing one: it throws at import time in a way that
  // reads like a broken test rather than a broken map.
  const src = readFileSync(join(CLI, "dev-resolver.mjs"), "utf8");
  const bad: string[] = [];
  for (const m of src.matchAll(
    /["'](@prometheus\/[a-z0-9/-]+)["']\s*:\s*resolvePath\(\s*PKG_ROOT\s*,([^)]*)\)/gi,
  )) {
    const spec = m[1] as string;
    const parts = (m[2] as string)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    const p = resolve(ROOT, "packages", ...parts);
    if (!existsSync(p)) bad.push(`${spec} → ${p}`);
  }
  assert.deepEqual(bad, [], "dev-resolver maps a specifier to a path that does not exist");
});
