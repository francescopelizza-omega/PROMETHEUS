/**
 * main/model-health-ipc.ts — the `modelHealth:*` ipcMain handlers for the Model Health
 * feature (RELAY-ONLY, mirrors path-completion-ipc.ts): lists the on-disk
 * `ModelHealthStore` for the Settings page to render, and records one fresh
 * `EndpointHealthRecord` after a turn via model-health-store.ts's fail-soft
 * read/merge/write.
 *
 * Unlike path-completion (which takes a renderer-supplied `dir`/`workspaceRoot`), the
 * store path here is a single MAIN-process-owned constant (`<userData>/model-health.json`,
 * resolved by the caller and passed in as `globalPath`) — there is no path in the arg at
 * all, so there is nothing for a compromised/buggy renderer to redirect.
 */
import { parseEndpointHealthRecord } from "@prometheus/core";
import { ipcMain } from "electron";

import {
  IPC,
  type ModelHealthListResult,
  type ModelHealthRecordResult,
} from "../shared/ipc-contract.js";
import { loadModelHealth, recordEndpointHealth } from "./model-health-store.js";

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Register the `modelHealth:*` handlers. Returns a disposer (mirrors sibling IPC modules). */
export function registerModelHealthIpcHandlers(globalPath: string): () => void {
  ipcMain.handle(IPC.modelHealthList, async (_e): Promise<ModelHealthListResult> => {
    try {
      return { ok: true, store: await loadModelHealth(globalPath) };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(
    IPC.modelHealthRecord,
    async (_e, arg: unknown): Promise<ModelHealthRecordResult> => {
      try {
        // Full-shape validation, not just endpointId/model: this handler used to cast the
        // renderer's argument straight through to disk, so any partial/malformed record (a
        // buggy future caller, a compromised renderer) would persist verbatim and crash
        // Settings ▸ Model Health the next time it read a missing/wrong-typed field back out.
        const record = parseEndpointHealthRecord(arg);
        if (!record) {
          return {
            ok: false,
            error:
              "endpointId and model are required, and the record must be a well-formed EndpointHealthRecord",
          };
        }
        await recordEndpointHealth(globalPath, record);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  return () => {
    for (const channel of [IPC.modelHealthList, IPC.modelHealthRecord]) {
      ipcMain.removeHandler(channel);
    }
  };
}
