// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ollama-ipc.ts — the `model:ollamaStart` handler: a manual "Start" trigger for the raw
 * Ollama daemon, wired to the SAME `ensureOllamaRunning` that `ai-ipc.ts`'s `runAiStream`
 * calls automatically on a chat prompt. Deliberately separate from `model-ipc.ts`'s
 * `model:serve` (the fit-derived HF ServeProfile lifecycle via `ServeSupervisor`) — see
 * ipc-contract.ts's docstring on the channel for why conflating the two would break both.
 */
import { ai } from "@prometheus/core";
import { ipcMain } from "electron";

import { IPC, type ModelOllamaStartResult } from "../shared/ipc-contract.js";

/** Register `model:ollamaStart`. Returns a disposer (mirrors sibling IPC modules). */
export function registerOllamaIpc(): () => void {
  ipcMain.handle(IPC.modelOllamaStart, async (): Promise<ModelOllamaStartResult> => {
    const result = await ai.ensureOllamaRunning({});
    return {
      started: result.started,
      ok: result.endpoint !== undefined,
      ...(result.endpoint?.model ? { model: result.endpoint.model } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.resourceReason ? { resourceReason: result.resourceReason } : {}),
    };
  });

  return () => {
    ipcMain.removeHandler(IPC.modelOllamaStart);
  };
}
