// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/model-wizard-ipc.ts — the `modelWizard:*` channels (see `model-wizard.ts`).
 *
 * Every argument is validated inside `model-wizard.ts` (it takes `unknown` and checks shapes
 * itself), so nothing the renderer sends is trusted on the way in, and no channel returns a key.
 */
import { ipcMain } from "electron";

import { IPC } from "../shared/ipc-contract.js";
import { modelWizard } from "./model-wizard.js";

/** Register the `modelWizard:*` channels; returns the disposer. */
export function registerModelWizardIpc(): () => void {
  const w = modelWizard();
  ipcMain.handle(IPC.modelWizardStep, (_e, arg) => w.step(arg));
  ipcMain.handle(IPC.modelWizardPlan, (_e, arg) => w.plan(arg));
  ipcMain.handle(IPC.modelWizardSetKey, (_e, arg) => w.setKey(arg));
  ipcMain.handle(IPC.modelWizardLiveModels, (_e, arg) => w.liveModels(arg));
  ipcMain.handle(IPC.modelWizardChoose, (_e, arg) => w.choose(arg));
  ipcMain.handle(IPC.modelWizardEndpoints, () => w.endpoints());
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
