// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/model-wizard-ipc.ts — the `modelWizard:*` channels (see `model-wizard.ts`).
 *
 * Every argument is validated inside `model-wizard.ts` (it takes `unknown` and checks shapes
 * itself), so nothing the renderer sends is trusted on the way in, and no channel returns a key.
 */
import { describeEngineFailure } from "@prometheus/engine-bridge";
import { ipcMain } from "electron";

import { IPC } from "../shared/ipc-contract.js";
import { modelWizard } from "./model-wizard.js";

/** Register the `modelWizard:*` channels; returns the disposer. */
/**
 * Every channel answers `{ok:false, error}` instead of rejecting. Several wizard methods had no
 * try/catch of their own, so a throw (an unreadable models file, a provider that hung up)
 * rejected the invoke and the renderer showed a generic IPC failure instead of the reason.
 */
function enveloped<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
): (...a: A) => Promise<R | { ok: false; error: string }> {
  return async (...a: A) => {
    try {
      return await fn(...a);
    } catch (e) {
      return { ok: false, error: describeEngineFailure(e) };
    }
  };
}

export function registerModelWizardIpc(): () => void {
  const w = modelWizard();
  ipcMain.handle(
    IPC.modelWizardStep,
    enveloped((_e: unknown, arg: unknown) => w.step(arg)),
  );
  ipcMain.handle(
    IPC.modelWizardPlan,
    enveloped((_e: unknown, arg: unknown) => w.plan(arg)),
  );
  ipcMain.handle(
    IPC.modelWizardSetKey,
    enveloped((_e: unknown, arg: unknown) => w.setKey(arg)),
  );
  ipcMain.handle(
    IPC.modelWizardLiveModels,
    enveloped((_e: unknown, arg: unknown) => w.liveModels(arg)),
  );
  ipcMain.handle(
    IPC.modelWizardChoose,
    enveloped((_e: unknown, arg: unknown) => w.choose(arg)),
  );
  ipcMain.handle(
    IPC.modelWizardEndpoints,
    enveloped(() => w.endpoints()),
  );
  return () => {
    for (const ch of [
      IPC.modelWizardStep,
      IPC.modelWizardPlan,
      IPC.modelWizardSetKey,
      IPC.modelWizardLiveModels,
      IPC.modelWizardChoose,
      IPC.modelWizardEndpoints,
    ]) {
      ipcMain.removeHandler(ch);
    }
  };
}
