import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
/**
 * dev-resolver.mjs — a tiny ESM resolver hook so the prom CLI RUNS directly from
 * TypeScript source under Node 20+ (native type-stripping) WITHOUT a build step
 * or installed node_modules. It maps the workspace bare specifiers
 * `@prometheus/engine-bridge` and `@prometheus/core` to each package's
 * src/index.ts (mirroring the tsconfig `paths`). The production path is a normal
 * `tsc -b` emit to dist/ + the package.json "bin" — this hook is dev/proof only.
 *
 * Usage:
 *   node --import ./dev-register.mjs src/bin.ts scan
 * or inline:
 *   node --import 'data:text/javascript,import {register} from "node:module";
 *     register("file://<abs>/dev-resolver.mjs");' src/bin.ts scan
 */
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // …/studio/apps/cli
const PKG_ROOT = resolvePath(HERE, "..", "..", "packages"); // …/studio/packages

const MAP = {
  "@prometheus/engine-bridge": resolvePath(PKG_ROOT, "engine-bridge", "src", "index.ts"),
  "@prometheus/core": resolvePath(PKG_ROOT, "core", "src", "index.ts"),
  // pure agent-checkpoint subpath (APP-051) — the sandboxed renderer + node:test reach
  // core's checkpoint model here WITHOUT the node-heavy barrel (mirrors /rules).
  "@prometheus/core/agent-checkpoint": resolvePath(
    PKG_ROOT,
    "core",
    "src",
    "agent",
    "checkpoint.ts",
  ),
  // pure session-store subpath (APP-052) — session model + search + JSONL round-trip.
  "@prometheus/core/agent-session": resolvePath(
    PKG_ROOT,
    "core",
    "src",
    "agent",
    "session-store.ts",
  ),
  // pure keymap subpath (APP-057) — presets + conflict detection + the user-override
  // layer; the sandboxed renderer container (SettingsPanel) reaches it WITHOUT the barrel.
  "@prometheus/core/keymap": resolvePath(PKG_ROOT, "core", "src", "settings", "keymap.ts"),
  // pure migrations subpath (APP-067) — the versioned state migration runner; the
  // sandboxed renderer reaches runMigrations for crash-recovery WITHOUT the barrel.
  "@prometheus/core/migrations": resolvePath(PKG_ROOT, "core", "src", "migrations", "index.ts"),
  // The CLI consumes the design-system TOKENS only (08 §8.1): the react-free
  // "@prometheus/ui/tokens" subpath = src/tokens.ts (ramps + verdict maps + the
  // ANSI-16 resolver). NEVER map the root "@prometheus/ui" here — its index pulls
  // React/JSX components Node's type-stripping can't transform.
  "@prometheus/ui/tokens": resolvePath(PKG_ROOT, "ui", "src", "tokens.ts"),
};

const tsResult = (absPath) => ({
  url: pathToFileURL(absPath).href,
  format: "module-typescript",
  shortCircuit: true,
});

export async function resolve(specifier, context, nextResolve) {
  // 1) workspace bare specifiers -> package src/index.ts
  const mapped = MAP[specifier];
  if (mapped) return tsResult(mapped);

  // 2) TS-style ESM imports use explicit ".js" extensions that map to ".ts"/".tsx"
  //    on disk. When a relative ".js" target doesn't exist, rewrite to ".ts" first
  //    (the common case) and then ".tsx" (a React component). This is strictly
  //    ADDITIVE — the ".tsx" branch only runs when neither the ".js" nor the ".ts"
  //    sibling exists, so existing ".js"→".ts" resolutions are unchanged.
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL
  ) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    const asJs = resolvePath(parentDir, specifier);
    if (!existsSync(asJs)) {
      const base = asJs.slice(0, -3);
      const asTs = `${base}.ts`;
      if (existsSync(asTs)) return tsResult(asTs);
      const asTsx = `${base}.tsx`;
      if (existsSync(asTsx)) return tsResult(asTsx);
    }
  }

  return nextResolve(specifier, context);
}
