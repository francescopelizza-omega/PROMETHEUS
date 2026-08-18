import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
/**
 * dev-resolver.mjs — a tiny ESM resolver hook so the prometheus CLI RUNS directly from
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
  // The HOST-side system tools (working-set scope guard, exec runner/gate, reaper).
  //
  // Missing from this map, `@prometheus/core/agent-system-host` fell through to node's own
  // resolution → package.json `exports` → `dist/`. So every node:test run that touched it was
  // exercising the last BUILT output rather than the source under edit: a change to
  // `isPathAllowed` looked like it had no effect, and a stale dist could keep a suite green
  // across a source regression. Any core subpath the CLI imports belongs here — see
  // `dev-resolver.test.ts`, which now fails when one is added to `exports` and not to MAP.
  "@prometheus/core/agent-system-host": resolvePath(
    PKG_ROOT,
    "core",
    "src",
    "agent",
    "system",
    "host",
    "index.ts",
  ),
  "@prometheus/core/agent-system": resolvePath(
    PKG_ROOT,
    "core",
    "src",
    "agent",
    "system",
    "index.ts",
  ),
  "@prometheus/core/agent-protocol": resolvePath(
    PKG_ROOT,
    "core",
    "src",
    "agent",
    "protocol",
    "index.ts",
  ),
  "@prometheus/core/agent-loop": resolvePath(PKG_ROOT, "core", "src", "agent", "loop.ts"),
  "@prometheus/core/agent-tools": resolvePath(PKG_ROOT, "core", "src", "agent", "tools.ts"),
  "@prometheus/core/agent-patch": resolvePath(PKG_ROOT, "core", "src", "agent", "patch.ts"),
  "@prometheus/core/agent-compact": resolvePath(PKG_ROOT, "core", "src", "agent", "compact.ts"),
  "@prometheus/core/agent-todo": resolvePath(PKG_ROOT, "core", "src", "agent", "todo.ts"),
  "@prometheus/core/agent-subagent": resolvePath(PKG_ROOT, "core", "src", "agent", "subagent.ts"),
  "@prometheus/core/agent-question": resolvePath(PKG_ROOT, "core", "src", "agent", "question.ts"),
  "@prometheus/core/agent-permissions": resolvePath(
    PKG_ROOT,
    "core",
    "src",
    "agent",
    "permissions.ts",
  ),
  "@prometheus/core/ai-retry": resolvePath(PKG_ROOT, "core", "src", "ai", "retry-index.ts"),
  "@prometheus/core/agent-events": resolvePath(PKG_ROOT, "core", "src", "agent", "events.ts"),
  "@prometheus/core/agent-exec": resolvePath(PKG_ROOT, "core", "src", "agent", "exec", "index.ts"),
  "@prometheus/core/agent-authorization": resolvePath(
    PKG_ROOT,
    "core",
    "src",
    "agent",
    "authorization.ts",
  ),
  "@prometheus/core/ai-effort": resolvePath(PKG_ROOT, "core", "src", "ai", "effort", "index.ts"),
  // Found by `dev-resolver.test.ts` the moment it was written — a second subpath the CLI
  // imports that was silently resolving to dist/.
  "@prometheus/core/mcp-node": resolvePath(PKG_ROOT, "core", "src", "mcp", "host", "node.ts"),
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
  // pure git-worktree subpath (desktop parity, Task #5) — the dependency-injected git
  // wrappers `git-helpers.ts` re-exports and the desktop worktree IPC calls directly.
  "@prometheus/core/git-worktree": resolvePath(PKG_ROOT, "core", "src", "git", "worktree.ts"),
  // pure agent-files subpath (desktop parity, Task #5) — `loadAgentFile` + `personaSystemPrompt`
  // / `personaDeny`, which desktop's run-controller.ts imports directly (no CLI import today,
  // mapped anyway so a future CLI import — or a desktop node:test run through this SAME
  // resolver — never silently falls through to a stale `dist/`).
  "@prometheus/core/agent-files": resolvePath(PKG_ROOT, "core", "src", "agent", "agent-files.ts"),
  // pure command-loader/-gate subpaths (desktop parity, Task #5) — the markdown slash-command
  // parser + trust policy the CLI's `command-files.ts` calls; desktop's renderer-side loader
  // calls the exact same functions.
  "@prometheus/core/command-loader": resolvePath(PKG_ROOT, "core", "src", "commands", "loader.ts"),
  "@prometheus/core/command-gate": resolvePath(PKG_ROOT, "core", "src", "commands", "gate.ts"),
  // pure path-completion subpath — the "@"-path fuzzy scorer + frecency store shared by the
  // CLI composer and the desktop renderer/main; framework-free so it's renderer-safe too.
  "@prometheus/core/path-completion": resolvePath(
    PKG_ROOT,
    "core",
    "src",
    "path-completion",
    "index.ts",
  ),
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
