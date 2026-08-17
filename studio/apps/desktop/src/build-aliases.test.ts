/**
 * build-aliases.test.ts — every `@prometheus/core` subpath export has a vite alias.
 *
 * `electron.vite.config.ts` already carried a comment saying, in as many words, that adding a
 * subpath to `packages/core/package.json` without adding it here breaks the desktop build the
 * moment anything imports it. It then happened anyway: `./agent-exec`, `./agent-system` and
 * `./agent-system-host` were added to core and imported from main and the renderer, and the
 * build died with `ENOTDIR: not a directory, open …/src/index.ts/agent-system`.
 *
 * It got that far because the failure is invisible to the two gates that were being run:
 * `tsc` resolves subpaths through package.json `exports`, and node:test resolves them through
 * the dev-register hook. Only vite uses this alias table, and only `electron-vite build` runs
 * vite. So a comment was the wrong instrument — this is the same rule as a build failure.
 *
 * It also pins the ORDER rule, which is the subtler half: vite matches a string alias by
 * prefix, so a shorter specifier listed before a longer one that extends it silently rewrites
 * the longer one into a path that does not exist.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = dirname(HERE);
const ROOT = dirname(dirname(DESKTOP));

/** The subpath keys the vite config aliases, in declaration order. */
function aliasedSubpaths(): string[] {
  const src = readFileSync(join(DESKTOP, "electron.vite.config.ts"), "utf8");
  const block = /const CORE_SUBPATHS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, "CORE_SUBPATHS is no longer a single object literal in the vite config");
  return [...(block[1] ?? "").matchAll(/"(@prometheus\/core\/[^"]+)"\s*:/g)].map(
    (m) => m[1] as string,
  );
}

/** The subpath exports core actually publishes (`.` is the barrel, aliased separately). */
function exportedSubpaths(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  return Object.keys(pkg.exports ?? {})
    .filter((k) => k !== "." && k.startsWith("./"))
    .map((k) => `@prometheus/core${k.slice(1)}`);
}

test("every core subpath export is aliased for the desktop build", () => {
  const aliased = new Set(aliasedSubpaths());
  const missing = exportedSubpaths().filter((s) => !aliased.has(s));
  assert.deepEqual(
    missing,
    [],
    "these core subpaths have no vite alias, so importing one from apps/desktop fails the " +
      "build with ENOTDIR — add them to CORE_SUBPATHS in apps/desktop/electron.vite.config.ts",
  );
});

test("no aliased subpath is listed before another that extends it", () => {
  // `@prometheus/core/agent-system` before `@prometheus/core/agent-system-host` rewrites the
  // host specifier to `…/agent/system/index.ts-host`. The build error names the WRONG file,
  // which is what makes this worth a test rather than care.
  const order = aliasedSubpaths();
  for (let i = 0; i < order.length; i += 1) {
    for (let j = i + 1; j < order.length; j += 1) {
      const earlier = order[i] as string;
      const later = order[j] as string;
      assert.ok(
        !later.startsWith(`${earlier}-`) && !later.startsWith(`${earlier}/`),
        `"${earlier}" is listed before "${later}", which it prefixes — swap them`,
      );
    }
  }
});

test("the bare barrel alias comes LAST, after every subpath", () => {
  // The bare `@prometheus/core` prefixes all of them, so listing it first would rewrite every
  // subpath into `…/src/index.ts/<rest>` — the exact ENOTDIR this file exists for.
  const src = readFileSync(join(DESKTOP, "electron.vite.config.ts"), "utf8");
  const spread = src.indexOf("Object.entries(CORE_SUBPATHS)");
  const bare = src.indexOf('"@prometheus/core": resolve(');
  assert.ok(spread > 0 && bare > 0, "the alias table no longer has the expected shape");
  assert.ok(bare > spread, "the bare @prometheus/core alias must come after the subpath spread");
});
