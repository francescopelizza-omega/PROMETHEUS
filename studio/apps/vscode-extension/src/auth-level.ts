/**
 * auth-level.ts — which autonomy level this extension runs at, and where it comes from.
 *
 * There was no shared answer. The CLI kept the level in a file, the desktop app in renderer
 * localStorage, and this extension in a `prometheus.authLevel` VS Code setting whose range was
 * `0..1` — not even the same ladder as core's `0..7`, which every other surface uses and which
 * `authDecision` is written against. One name, three settings, none of which could see the
 * others: setting A6 in the terminal changed nothing here, and nothing here was visible there.
 *
 * The rule now, most specific first:
 *
 *   1. `prometheus.authLevel`, when the user has EXPLICITLY set it (workspace or global). A
 *      per-workspace override is a real need — a repo you trust less than your own machine —
 *      and VS Code's settings UI is the natural place to express it. Per-FOLDER is not available:
 *      the setting is window-scoped in package.json, so in a multi-root workspace every folder
 *      shares one level.
 *   2. the shared store, `~/.prometheus/config/authorisation.json`, so the posture chosen in
 *      the terminal or the app follows you into the editor.
 *   3. core's safe default.
 *
 * `inspect()` is what makes (1) and (2) distinguishable: `get()` alone always returns a value —
 * the package.json default — so a user who never touched the setting would look like one who
 * had deliberately pinned it to 1, and the shared level could never win.
 */
import { cliProfiles } from "@prometheus/core";
import { DEFAULT_AUTH_LEVEL, MAX_AUTH_LEVEL } from "@prometheus/core/agent-authorization";
import type * as vscode from "vscode";

/** Clamp anything to a real rung of the ladder. */
function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_AUTH_LEVEL;
  return Math.max(0, Math.min(Math.trunc(n), MAX_AUTH_LEVEL));
}

/**
 * The level the user pinned in settings, or undefined when they never touched it.
 *
 * Deliberately does NOT consult `workspaceFolderValue`. `prometheus.authLevel` declares no
 * `scope` in package.json, so it is window-scoped and VS Code can never produce a per-folder
 * value for it — reading the field only certified a path production cannot take. Giving it
 * `"scope": "resource"` is a SECURITY decision, not a symmetry cleanup: a folder's
 * `.vscode/settings.json` travels with a cloned repo, and this extension declares no Workspace
 * Trust posture, so a resource-scoped autonomy level would let untrusted repo content pin itself
 * to 7. Per-workspace (`workspaceValue`) is the override the docstring above asks for, and it
 * already works.
 */
function explicitSetting(cfg: vscode.WorkspaceConfiguration): number | undefined {
  const probe = cfg.inspect<number>("authLevel");
  const pinned = probe?.workspaceValue ?? probe?.globalValue ?? undefined;
  return typeof pinned === "number" ? clamp(pinned) : undefined;
}

/**
 * Resolve the level for a session.
 *
 * `readShared` is injected so this is testable without touching a real home; production passes
 * the shared store from `@prometheus/core`.
 */
export function resolveAuthLevel(
  cfg: vscode.WorkspaceConfiguration,
  readShared: () => number | null = defaultReadShared,
): number {
  const pinned = explicitSetting(cfg);
  if (pinned !== undefined) return pinned;
  const shared = readShared();
  return shared === null ? DEFAULT_AUTH_LEVEL : clamp(shared);
}

/**
 * Read the shared store, never throwing.
 *
 * A STATIC import, not a `require`. The lazy `require("@prometheus/core")` this replaces could
 * never succeed and so silently disabled precedence rule (2) entirely: core is `"type": "module"`
 * and its `exports` map declares no `require` (and no `default`) condition, so a CommonJS require
 * fails resolution outright — and in the shipped `.vsix` the module is not even on disk
 * (`.vscodeignore` drops `node_modules/**`, `vsce package --no-dependencies`). Every call landed
 * in the `catch`, so the terminal's saved level never followed the user into the editor.
 *
 * The stated reason for the lazy require — not dragging the root barrel into activation — was
 * already moot: `extension.ts` and `llm.ts` both import it statically, so esbuild has it in the
 * bundle regardless. A failure here is still not an error: it means "no shared level", and the
 * caller falls back to the safe default.
 */
function defaultReadShared(): number | null {
  try {
    return cliProfiles.readSavedAuthLevel() ?? null;
  } catch {
    return null;
  }
}
