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
import { ipcMain } from "electron";

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

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stringField(a: Record<string, unknown>, key: string): string | undefined {
  return typeof a[key] === "string" ? (a[key] as string) : undefined;
}

export interface SettingsIpcOptions {
  /** where the global layer persists (defaults to `<userData>/settings.json`). */
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
   */
  onEffective?: (effective: coreSettings.Settings) => void;
}

/** Register the `settings:*` handlers. Returns a disposer (mirrors sibling IPC modules). */
export function registerSettingsIpcHandlers(opts: SettingsIpcOptions): () => void {
  const globalPath = opts.globalPath;
  /** Resolve + publish the posture. Fail-soft: a settings read must never break a handler. */
  const publish = async (workspaceRoot?: string): Promise<void> => {
    if (!opts.onEffective) return;
    try {
      const { effective } = await loadEffective(globalPath, workspaceRoot);
      opts.onEffective(effective as unknown as coreSettings.Settings);
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
      opts.onEffective?.(effective as unknown as coreSettings.Settings);
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
      const { global, workspace } = await loadEffective(globalPath, workspaceRoot);
      if (scope === "global") {
        await writeLayerAtomic(globalPath, coreSettings.setInLayer(global, key, a.value));
      } else {
        await writeLayerAtomic(
          workspaceSettingsPath(workspaceRoot as string),
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
      const { global, workspace } = await loadEffective(globalPath, workspaceRoot);
      if (scope === "global") {
        await writeLayerAtomic(globalPath, coreSettings.resetInLayer(global, key));
      } else {
        await writeLayerAtomic(
          workspaceSettingsPath(workspaceRoot as string),
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
