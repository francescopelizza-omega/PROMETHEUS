// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/settings-ipc.ts — the `settings:*` ipcMain handlers (file 13 §2.1/§2.7).
 *
 * RELAY-ONLY (mirrors mcp-ipc.ts / security-ipc.ts): validates the renderer's arg,
 * delegates to the pure disk-persistence helpers in settings-store.ts, maps the result
 * to the renderer-safe shape. Keys are NEVER caller-supplied file paths — only
 * schemaKeys the tree recognizes — and only `global`/`workspace` are writable scopes
 * (built-in profiles are a fixed, non-editable bundle selected via `profileId`).
 */
import { settings as coreSettings } from "@prometheus/core";
import { describeEngineFailure } from "@prometheus/engine-bridge";
import { dialog, ipcMain } from "electron";

import { assertNotSensitivePath } from "./ide/path-guard.js";

import {
  IPC,
  type SettingsGetResult,
  type SettingsListResult,
  type SettingsResetResult,
  type SettingsSetResult,
  type SettingsWriteScope,
} from "../shared/ipc-contract.js";
import {
  loadEffective,
  resolveRichRows,
  toRowView,
  workspaceSettingsPath,
  writeLayerAtomic,
} from "./settings-store.js";

// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

function stringField(a: Record<string, unknown>, key: string): string | undefined {
  return typeof a[key] === "string" ? (a[key] as string) : undefined;
}

export interface SettingsIpcOptions {
  /** where the global layer persists — the shared `$PROMETHEUS_HOME/config/settings.json`
   *  (main/settings-path.ts), NOT Electron's private userData. */
  globalPath: string;
  /**
   * Fired with the resolved settings whenever they are read or written.
   *
   * This is how the security keys reach the code that enforces them. It fires on `list` (the
   * renderer's first call, and the one that carries the workspace root), and on `set`/`reset`.
   * The startup adoption is separate and happens BEFORE the AI handlers register — see
   * `adoptSecurityPosture` — so there is no window in which a locked-down GLOBAL profile is
   * configured but not yet in force; this seam is what additionally picks up a per-workspace
   * layer once a workspace is actually open.
   *
   * `raw` carries the UNMERGED global/workspace layers (plus the workspace root, when any) —
   * `effective.hooks` has already been through `layerSettings`' array-replace merge and cannot
   * be trusted for anything security-relevant; a caller vetting hooks needs the two raw layers
   * separately (see `agent-hooks.ts`'s `setHookSettings`).
   */
  onEffective?: (
    effective: coreSettings.Settings,
    raw: {
      workspaceRoot?: string;
      global: Record<string, unknown>;
      workspace: Record<string, unknown>;
    },
  ) => void;
}

/** Register the `settings:*` handlers. Returns a disposer (mirrors sibling IPC modules). */
export function registerSettingsIpcHandlers(opts: SettingsIpcOptions): () => void {
  const globalPath = opts.globalPath;
  /** Resolve + publish the posture. Fail-soft: a settings read must never break a handler. */
  const publish = async (workspaceRoot?: string): Promise<void> => {
    if (!opts.onEffective) return;
    try {
      const { effective, global, workspace } = await loadEffective(globalPath, workspaceRoot);
      opts.onEffective(effective as unknown as coreSettings.Settings, {
        ...(workspaceRoot ? { workspaceRoot } : {}),
        global,
        workspace,
      });
    } catch {
      /* keep the last known posture rather than silently widening to the default */
    }
  };
  // Adopt whatever is on disk NOW, so the policy is in force before the first model call —
  // not only after the user happens to open the settings page.
  void publish();

  ipcMain.handle(IPC.settingsList, async (_e, arg: unknown): Promise<SettingsListResult> => {
    try {
      const a = (arg ?? {}) as Record<string, unknown>;
      const workspaceRoot = stringField(a, "workspaceRoot");
      const { effective, global, profile, workspace } = await loadEffective(
        globalPath,
        workspaceRoot,
      );
      // Adopt the posture for THIS workspace. The startup publish runs before any workspace is
      // open, so it resolves the global layers only — a repo whose `.prometheus/settings.json`
      // TIGHTENS the posture would otherwise not take effect until some unrelated write
      // happened to pass a root. `settings:list` is the renderer's first call and it carries
      // the root, so this is where a per-workspace posture actually lands.
      opts.onEffective?.(effective as unknown as coreSettings.Settings, {
        ...(workspaceRoot ? { workspaceRoot } : {}),
        global,
        workspace,
      });
      // APP-058: rich rows (per-scope raw values + the full definedIn chain), profile layer
      // INCLUDED so a profile-set key is labeled "profile", not mislabeled "default".
      const bySchemaKey = resolveRichRows(global, profile, workspace);
      return { ok: true, nodes: coreSettings.SETTINGS_TREE.map((n) => toRowView(n, bySchemaKey)) };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.settingsGet, async (_e, arg: unknown): Promise<SettingsGetResult> => {
    try {
      const a = (arg ?? {}) as Record<string, unknown>;
      const key = stringField(a, "key");
      if (!key) return { ok: false, error: "key is required" };
      if (!coreSettings.findNodeBySchemaKey(key)) {
        return { ok: false, error: `unknown settings key: ${key}` };
      }
      const { effective, global, profile, workspace } = await loadEffective(
        globalPath,
        stringField(a, "workspaceRoot"),
      );
      // profile INCLUDED (APP-058 fix) so a profile-set key isn't mislabeled "default".
      const row = coreSettings.resolveProvenance(key, effective, { global, profile, workspace });
      return { ok: true, value: row.value, layer: row.layer };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.settingsSet, async (_e, arg: unknown): Promise<SettingsSetResult> => {
    try {
      const a = (arg ?? {}) as Record<string, unknown>;
      const key = stringField(a, "key");
      if (!key) return { ok: false, error: "key is required" };
      if (!coreSettings.findNodeBySchemaKey(key)) {
        return { ok: false, error: `unknown settings key: ${key}` };
      }
      const scope = a.scope as SettingsWriteScope;
      if (scope !== "global" && scope !== "workspace") {
        return { ok: false, error: 'scope must be "global" or "workspace"' };
      }
      const workspaceRoot = stringField(a, "workspaceRoot");
      if (scope === "workspace" && !workspaceRoot) {
        return { ok: false, error: "workspaceRoot is required for scope=workspace" };
      }
      // `workspaceRoot` is renderer-supplied and reaches `workspaceSettingsPath` unnormalised,
      // so a relative or `~/.ssh`-shaped root would have a settings file written under it.
      // Denylist ONLY: this is a real project directory the user chose, not a granted
      // working-set path, and `assertNotSensitivePath` also resolves it to an absolute path.
      let safeRoot = workspaceRoot;
      if (scope === "workspace") {
        try {
          safeRoot = assertNotSensitivePath(workspaceRoot as string);
        } catch (e) {
          return { ok: false, error: errString(e) };
        }
      }
      const { global, workspace } = await loadEffective(globalPath, workspaceRoot);
      if (scope === "global") {
        const next = coreSettings.setInLayer(global, key, a.value);
        // A write that WEAKENS the security posture, or adds commands that run on their own
        // (hooks), is the human's decision — not the renderer's. A compromised renderer could
        // otherwise turn the gate off, allow --force and widen the network in three calls
        // with nothing on screen. Main asks natively; Cancel is the default.
        const weakening = postureWeakening(
          global as Record<string, unknown>,
          next as Record<string, unknown>,
          key,
        );
        if (weakening) {
          const r = await dialog.showMessageBox({
            type: "warning",
            buttons: ["Cancel", "Change it"],
            defaultId: 0,
            cancelId: 0,
            message: `Change a security setting: ${key}?`,
            detail: `${weakening}\n\nNew value: ${JSON.stringify(a.value)?.slice(0, 600) ?? "(unset)"}`,
          });
          if (r.response !== 1) return { ok: false, error: "declined" };
        }
        await writeLayerAtomic(globalPath, next);
      } else {
        await writeLayerAtomic(
          workspaceSettingsPath(safeRoot as string),
          coreSettings.setInLayer(workspace, key, a.value),
        );
      }
      // Re-resolve immediately: a security key that only took effect after a restart would be
      // a control the user watched fail.
      await publish(workspaceRoot);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.settingsReset, async (_e, arg: unknown): Promise<SettingsResetResult> => {
    try {
      const a = (arg ?? {}) as Record<string, unknown>;
      const key = stringField(a, "key");
      if (!key) return { ok: false, error: "key is required" };
      if (!coreSettings.findNodeBySchemaKey(key)) {
        return { ok: false, error: `unknown settings key: ${key}` };
      }
      const scope = a.scope as SettingsWriteScope;
      if (scope !== "global" && scope !== "workspace") {
        return { ok: false, error: 'scope must be "global" or "workspace"' };
      }
      const workspaceRoot = stringField(a, "workspaceRoot");
      if (scope === "workspace" && !workspaceRoot) {
        return { ok: false, error: "workspaceRoot is required for scope=workspace" };
      }
      // `workspaceRoot` is renderer-supplied and reaches `workspaceSettingsPath` unnormalised,
      // so a relative or `~/.ssh`-shaped root would have a settings file written under it.
      // Denylist ONLY: this is a real project directory the user chose, not a granted
      // working-set path, and `assertNotSensitivePath` also resolves it to an absolute path.
      let safeRoot = workspaceRoot;
      if (scope === "workspace") {
        try {
          safeRoot = assertNotSensitivePath(workspaceRoot as string);
        } catch (e) {
          return { ok: false, error: errString(e) };
        }
      }
      const { global, workspace } = await loadEffective(globalPath, workspaceRoot);
      if (scope === "global") {
        const next = coreSettings.resetInLayer(global, key);
        // Same rule as settings:set — a reset back to a LOOSER default is still a loosening.
        const weakening = postureWeakening(
          global as Record<string, unknown>,
          next as Record<string, unknown>,
          key,
        );
        if (weakening) {
          const r = await dialog.showMessageBox({
            type: "warning",
            buttons: ["Cancel", "Reset it"],
            defaultId: 0,
            cancelId: 0,
            message: `Reset a security setting: ${key}?`,
            detail: weakening,
          });
          if (r.response !== 1) return { ok: false, error: "declined" };
        }
        await writeLayerAtomic(globalPath, next);
      } else {
        await writeLayerAtomic(
          workspaceSettingsPath(safeRoot as string),
          coreSettings.resetInLayer(workspace, key),
        );
      }
      // A reset can WIDEN the posture (back to the default), so it must republish too —
      // otherwise clearing `gateStrict` would leave the strict gate silently in force.
      await publish(workspaceRoot);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  return () => {
    for (const channel of [IPC.settingsList, IPC.settingsGet, IPC.settingsSet, IPC.settingsReset]) {
      ipcMain.removeHandler(channel);
    }
  };
}

/**
 * Why this global write needs a human, or null when it does not: it loosens the posture
 * (cloud on, wider network, gate floor removed, --force allowed) or changes lifecycle hooks
 * (commands that run on every tool call). Tightening never asks.
 */
export function postureWeakening(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  key: string,
): string | null {
  if (key === "hooks" || key.startsWith("hooks.")) {
    return "Hooks are shell commands Prometheus runs automatically around tool calls.";
  }
  const a = coreSettings.securityPosture(before as never);
  const b = coreSettings.securityPosture(after as never);
  const rank: Record<string, number> = { none: 0, "mcp-only": 1, allow: 2 };
  if (!a.allowCloud && b.allowCloud) return "This allows cloud models.";
  if ((rank[b.network] ?? 9) > (rank[a.network] ?? 9)) {
    return `This widens network access from "${a.network}" to "${b.network}".`;
  }
  if (a.minGateMode === "enforce" && b.minGateMode !== "enforce") {
    return "This removes the floor that keeps the nemesis gate enforcing.";
  }
  if (!a.allowForce && b.allowForce) return "This allows --force past a nemesis BLOCK.";
  return null;
}
