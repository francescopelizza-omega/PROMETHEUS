// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/lmstudio-ipc.ts — the `model:lmstudioStart` handler: a manual "Start" trigger for LM
 * Studio's own server (`lms server start`), wired to the SAME `ensureLmStudioRunning` that
 * `ai-ipc.ts`'s `runAiStream` calls automatically on a chat prompt against an LM Studio
 * endpoint. LM Studio's exact twin of `ollama-ipc.ts` — see that file's docstring for why this
 * is deliberately separate from `model-ipc.ts`'s `model:serve`.
 */
import { ai } from "@prometheus/core";
import { ipcMain } from "electron";

import { IPC, type ModelLmstudioStartResult } from "../shared/ipc-contract.js";

/** Register `model:lmstudioStart`. Returns a disposer (mirrors sibling IPC modules). */
export function registerLmstudioIpc(): () => void {
  ipcMain.handle(IPC.modelLmstudioStart, async (): Promise<ModelLmstudioStartResult> => {
    const result = await ai.ensureLmStudioRunning({});
    return {
      started: result.started,
      ok: result.endpoint !== undefined,
      ...(result.endpoint?.model ? { model: result.endpoint.model } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.resourceReason ? { resourceReason: result.resourceReason } : {}),
    };
  });

  return () => {
    ipcMain.removeHandler(IPC.modelLmstudioStart);
  };
}
