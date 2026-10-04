// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * scripts/check-type-deps.mjs — every type library a tsconfig asks for is one its package declares.
 *
 * WHY THIS EXISTS. From 2026-09-16 every clean install failed to build the CLI:
 *
 *     error TS2688: Cannot find type definition file for 'node'.
 *
 * `tsconfig.base.json` pinned `typeRoots` to `./node_modules/.pnpm/@types+node@20.19.43/...` — a
 * pnpm-INTERNAL store path for one exact version. It worked while something in the lockfile still
 * pulled 20.19.43; commit 1775baf dropped that version, and from then on only checkouts that still
 * had a leftover copy of it could build. The development checkout had two, so every local build and
 * typecheck passed, while install.sh and CI failed on every clean clone (external report, 2026-10-03).
 * Underneath it, six projects list "node" in `types` and not one declared `@types/node`: under the
 * isolated linker a package sees only what it declares, so nothing else could have resolved it.
 *
 * A stale directory is exactly what a local run cannot see past, so this checks the DECLARATIONS
 * rather than the build:
 *   1. no `typeRoots` entry may point into `node_modules/.pnpm` (the store's private layout);
 *   2. every name in `compilerOptions.types` must be declared by the tsconfig's own package —
 *      `@types/<name>`, or `<name>` itself for a package that ships its types (`vite/client` → vite).
 *
 * Run: node scripts/check-type-deps.mjs   (wired into `pnpm lint`).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAN = ["packages", "apps"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "release",
  ".git",
  "coverage",
  ".vscode-test",
  "staging",
]);
const TSCONFIG = /^tsconfig(\..+)?\.json$/;

/** JSON with comments and trailing commas, as tsc accepts it. Strings are left untouched. */
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function collect(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(join(dir, e.name), acc);
    } else if (TSCONFIG.test(e.name)) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

/** The package.json that owns `file`: the nearest one at or above its directory, inside ROOT. */
function owningPackage(file) {
  for (let dir = dirname(file); dir.startsWith(ROOT); dir = dirname(dir)) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) return pkg;
    if (dir === ROOT) break;
  }
  return null;
}

/** `vite/client` → `vite`, `@scope/pkg/sub` → `@scope/pkg`, `node` → `node`. */
function packageOf(typeName) {
  const parts = typeName.split("/");
  return typeName.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const files = [join(ROOT, "tsconfig.json"), join(ROOT, "tsconfig.base.json")].filter((f) =>
  existsSync(f),
);
for (const r of SCAN) collect(join(ROOT, r), files);

const violations = [];
for (const file of files.sort()) {
  let config;
  try {
    config = parseJsonc(readFileSync(file, "utf8"));
  } catch (err) {
    violations.push({ file, why: `could not be parsed: ${err.message}` });
    continue;
  }
  const options = config.compilerOptions ?? {};

  for (const root of options.typeRoots ?? []) {
    if (/node_modules[\\/]+\.pnpm([\\/]|$)/.test(root)) {
      violations.push({
        file,
        why: `typeRoots names pnpm's private store layout: ${root} — it exists only in checkouts that happen to have that exact directory; declare the @types package instead`,
      });
    }
  }

  const types = Array.isArray(options.types) ? options.types : [];
  if (types.length === 0) continue;
  const pkgFile = owningPackage(file);
  if (!pkgFile) {
    violations.push({ file, why: `lists types [${types.join(", ")}] but has no package.json` });
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const declared = new Set(
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
      (field) => Object.keys(pkg[field] ?? {}),
    ),
  );
  for (const name of types) {
    if (name.startsWith(".") || name.startsWith("/")) continue; // a path, not a package
    const base = packageOf(name);
    if (declared.has(`@types/${base}`) || declared.has(base)) continue;
    violations.push({
      file,
      why: `lists "${name}" in compilerOptions.types, but ${relative(ROOT, pkgFile)} declares neither @types/${base} nor ${base}`,
    });
  }
}

if (violations.length > 0) {
  console.error(`\ncheck-type-deps: ${violations.length} problem(s).\n`);
  for (const v of violations) {
    console.error(`  ${relative(ROOT, v.file)}`);
    console.error(`    ↳ ${v.why}\n`);
  }
  console.error(
    "Add the @types package to that package's devDependencies (then `pnpm install`), and never\n" +
      "point typeRoots into node_modules/.pnpm. A local build can pass anyway on a leftover\n" +
      "directory; a clean clone cannot.\n",
  );
  process.exit(1);
}

console.error(
  `check-type-deps: ${files.length} tsconfig files checked, every type library declared.`,
);
