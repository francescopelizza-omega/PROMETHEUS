import { isAbsolute } from "node:path";
/**
 * main/metadata-ipc.ts — the typed `metadata:*` + `file:open` ipcMain handlers (file 0C).
 *
 * The trusted side of the contextBridge for atomic file-metadata control (privacy
 * protection). RELAY-ONLY (mirrors repo-ipc.ts): every handler (1) zod-validates the
 * renderer's arg at the seam (metadata-validate.ts — bounded path, no leading dash), (2)
 * delegates to the engine-bridge MetadataClient — the ONLY python3 spawner (C5), which
 * runs the metadata.py sidecar (copy-then-replace, verify, never delete on failure), and
 * (3) returns a plain-data contract shape; no live handle ever crosses.
 *
 * MUTATION GUARD (C5): scrub/edit/timestomp are PLAN-ONLY unless the renderer passed
 * `confirm:true` — JS never silently mutates a user's file; the sidecar enforces the
 * same. `file:open` is the native picker (electron dialog), the ONLY new privileged seam.
 *
 * Node/Electron only (privileged main). Imports @prometheus/engine-bridge (forbidden in
 * the renderer). The pure arg validation lives in metadata-validate.ts.
 */
import { dialog, ipcMain, shell } from "electron";

import { type MetadataClientOptions, createMetadataClient } from "@prometheus/engine-bridge";

import {
  type FileOpenResult,
  IPC,
  type MetadataEditResult,
  type MetadataInspectResult,
  type MetadataScrubResult,
  type MetadataTimestompResult,
  type OpenPathResult,
} from "../shared/ipc-contract.js";
import {
  validateFileOpen,
  validateMetadataEdit,
  validateMetadataInspect,
  validateMetadataScrub,
  validateMetadataTimestomp,
} from "./metadata-validate.js";

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Construction-time wiring (the metadata client options). */
export interface MetadataIpcWiring {
  clientOptions?: MetadataClientOptions;
}

export function registerMetadataIpcHandlers(wiring: MetadataIpcWiring = {}): () => void {
  const client = createMetadataClient(wiring.clientOptions);

  // ── inspect (read all metadata) ────────────────────────────────────────────
  ipcMain.handle(
    IPC.metadataInspect,
    async (_evt, arg: unknown): Promise<MetadataInspectResult> => {
      const v = validateMetadataInspect(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      try {
        return await client.inspect(v.value.uri);
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  // ── scrub (strip metadata; plan unless confirm) ────────────────────────────
  ipcMain.handle(IPC.metadataScrub, async (_evt, arg: unknown): Promise<MetadataScrubResult> => {
    const v = validateMetadataScrub(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      return await client.scrub(v.value.uri, v.value.confirm);
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── edit (set one field; plan unless confirm) ──────────────────────────────
  ipcMain.handle(IPC.metadataEdit, async (_evt, arg: unknown): Promise<MetadataEditResult> => {
    const v = validateMetadataEdit(arg);
    if (!v.ok) return { ok: false, file: "", field: "", value: "", error: v.error.message };
    try {
      return await client.edit(v.value.uri, v.value.field, v.value.value, v.value.confirm);
    } catch (e) {
      return {
        ok: false,
        file: v.value.uri,
        field: v.value.field,
        value: v.value.value,
        error: errString(e),
      };
    }
  });

  // ── timestomp (normalize timestamps; plan unless confirm) ──────────────────
  ipcMain.handle(
    IPC.metadataTimestomp,
    async (_evt, arg: unknown): Promise<MetadataTimestompResult> => {
      const v = validateMetadataTimestomp(arg);
      if (!v.ok) return { ok: false, mtime: 0, atime: 0, error: v.error.message };
      try {
        return await client.timestomp(v.value.uri, v.value.mtime, v.value.atime, v.value.confirm);
      } catch (e) {
        return {
          ok: false,
          mtime: v.value.mtime,
          atime: v.value.atime ?? v.value.mtime,
          error: errString(e),
        };
      }
    },
  );

  // ── file:open (native picker — the one new privileged seam) ────────────────
  ipcMain.handle(IPC.fileOpen, async (_evt, arg: unknown): Promise<FileOpenResult> => {
    const v = validateFileOpen(arg);
    const title = v.ok && v.value.title ? v.value.title : "Select a file";
    try {
      const res = await dialog.showOpenDialog({ title, properties: ["openFile"] });
      const path = res.canceled || res.filePaths.length === 0 ? null : (res.filePaths[0] ?? null);
      return { ok: true, path, canceled: res.canceled };
    } catch (e) {
      return { ok: false, path: null, canceled: true };
    }
  });

  // ── path:open (open a file/folder/app with the OS default, OUTSIDE the app) ──
  // The renderer never touches the shell directly (C5); this is the one delegated
  // "open externally" seam. shell.openPath is the OS's own "open" (same as a Finder
  // double-click) — we only require an absolute path so a relative/garbage value
  // can't be handed to the OS.
  ipcMain.handle(IPC.openPath, async (_evt, arg: unknown): Promise<OpenPathResult> => {
    const path = arg && typeof arg === "object" ? (arg as { path?: unknown }).path : undefined;
    if (typeof path !== "string" || !path || !isAbsolute(path)) {
      return { ok: false, error: "an absolute path is required" };
    }
    try {
      const err = await shell.openPath(path); // "" on success, else an error string
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  return () => {
    for (const channel of [
      IPC.metadataInspect,
      IPC.metadataScrub,
      IPC.metadataEdit,
      IPC.metadataTimestomp,
      IPC.fileOpen,
      IPC.openPath,
    ]) {
      ipcMain.removeHandler(channel);
    }
  };
}
