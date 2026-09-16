/**
 * auth-level.test.ts — which autonomy level the extension runs at.
 *
 * Three things had to be true and only one of them was: the ladder must be core's 0–7 (the
 * setting was capped at 1), an operator who never touched the setting must inherit the level
 * saved by the CLI or the app (there was no shared store to inherit from), and an operator who
 * DID pin the setting must keep their pin.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthLevel } from "./auth-level.js";

/**
 * The two calls the resolver makes on a `WorkspaceConfiguration`.
 *
 * `inspect` is the load-bearing one: `get` always returns something (the package.json default),
 * so without `inspect` a user who never touched the setting is indistinguishable from one who
 * deliberately pinned it — and the shared level could never win.
 */
function cfg(pinned?: {
  globalValue?: number;
  workspaceValue?: number;
}): never {
  return {
    get: () => pinned?.globalValue ?? 1,
    inspect: () => ({ defaultValue: 1, ...(pinned ?? {}) }),
  } as never;
}

test("an explicitly pinned setting wins, most-local scope first", () => {
  assert.equal(
    resolveAuthLevel(cfg({ globalValue: 5 }), () => 2),
    5,
  );
  assert.equal(
    resolveAuthLevel(cfg({ globalValue: 5, workspaceValue: 3 }), () => 2),
    3,
  );
  // No per-FOLDER case: `prometheus.authLevel` is window-scoped, so VS Code can never produce a
  // `workspaceFolderValue` for it, and honouring one would mean a cloned repo's own
  // `.vscode/settings.json` could pin autonomy to 7 in an extension with no Workspace Trust gate.
  // `workspaceValue` is the per-project override the module actually promises.
});

test("with no pin, the SHARED level applies — the posture follows you into the editor", () => {
  assert.equal(
    resolveAuthLevel(cfg(), () => 6),
    6,
  );
  assert.equal(
    resolveAuthLevel(cfg(), () => 0),
    0,
  );
});

test("with no pin and nothing saved anywhere, the safe default applies", () => {
  assert.equal(
    resolveAuthLevel(cfg(), () => null),
    1,
  );
});

test("the ladder is core's 0–7, not the old 0–1 the setting was capped at", () => {
  // 7 used to be impossible to express here at all: package.json declared `maximum: 1`, so this
  // extension's "authLevel" was a different setting that happened to share a name.
  assert.equal(
    resolveAuthLevel(cfg({ globalValue: 7 }), () => null),
    7,
  );
  assert.equal(
    resolveAuthLevel(cfg(), () => 7),
    7,
  );
  // anything off the ladder is clamped rather than trusted
  assert.equal(
    resolveAuthLevel(cfg({ globalValue: 99 }), () => null),
    7,
  );
  assert.equal(
    resolveAuthLevel(cfg({ globalValue: -3 }), () => null),
    0,
  );
  assert.equal(
    resolveAuthLevel(cfg({ globalValue: Number.NaN }), () => null),
    1,
  );
});
