// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/privileged-ipc.ts — Studio's privileged gate (sudo), one per app.
 *
 * The ONLY path from Studio to root. The agent's `propose_elevated` (via `agent:systemTool`)
 * and the Disk Space panel's "Rescan as root" both reach `studioPrivilegedGate()`; its approver
 * is the window's human (`privileged-approver.ts` → `PrivilegedApprovalDialog`), and its
 * password route is `sudo -A` with the fixed askpass helper, so the password goes from a native
 * dialog straight to sudo and never through this process, an IPC payload or a log.
 *
 * A decision is accepted only from the webContents the request was sent to, only for a live
 * request id, and only once.
 */
import { homedir } from "node:os";
import { BrowserWindow, ipcMain } from "electron";

import { settings as coreSettings } from "@prometheus/core";
import {
  type PrivilegedGate,
  createPrivilegedGate,
  prepareAskpass,
  prometheusHome,
  scanCommand,
  verdictBlocks,
} from "@prometheus/core/agent-system-host";
import { verdictReasons } from "@prometheus/engine-bridge";

import { IPC } from "../shared/ipc-contract.js";
import { getSecurityPosture } from "./ai-ipc.js";
import { createStudioApprover } from "./privileged-approver.js";

let gate: PrivilegedGate | null = null;

/** The app's privileged gate, or undefined before registration (then nothing can run as root). */
export function studioPrivilegedGate(): PrivilegedGate | undefined {
  return gate ?? undefined;
}

export function registerPrivilegedIpcHandlers(): () => void {
  const { approver, decide } = createStudioApprover((channel, payload) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return false;
    win.webContents.send(channel, payload);
    return win.webContents.id;
  });
  ipcMain.handle(IPC.privilegedDecide, (e, arg: unknown) => decide(arg, e.sender.id));
  gate = createPrivilegedGate({
    approver,
    passwordVia: "askpass",
    askpass: () => prepareAskpass(),
    home: prometheusHome(),
    userHome: homedir(),
    scan: async (line) => {
      const mode = coreSettings.effectiveGateMode("enforce", getSecurityPosture());
      if (mode === "off") return { blocked: false };
      const v = await scanCommand(line);
      return verdictBlocks(v, mode)
        ? { blocked: true, reason: verdictReasons(v).join("; ") || v.verdict }
        : { blocked: false };
    },
  });
  return () => {
    ipcMain.removeHandler(IPC.privilegedDecide);
    gate = null;
  };
}
