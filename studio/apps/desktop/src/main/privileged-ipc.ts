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
import { BrowserWindow, dialog, ipcMain } from "electron";

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
import { pageOfUrl } from "./ipc-sender-guard.js";
import { createStudioApprover } from "./privileged-approver.js";

let gate: PrivilegedGate | null = null;

/** The app's privileged gate, or undefined before registration (then nothing can run as root). */
export function studioPrivilegedGate(): PrivilegedGate | undefined {
  return gate ?? undefined;
}

/** The workbench window — the only page that renders (and may answer) the approval card.
 *  The focused window first if it IS the workbench, else any workbench, else the first. */
function workbenchWindow(): BrowserWindow | undefined {
  const isBench = (w: BrowserWindow | null | undefined): w is BrowserWindow =>
    !!w && !w.isDestroyed() && pageOfUrl(w.webContents.getURL()) === "workbench";
  const focused = BrowserWindow.getFocusedWindow();
  if (isBench(focused)) return focused;
  return BrowserWindow.getAllWindows().find(isBench) ?? BrowserWindow.getAllWindows()[0];
}

export function registerPrivilegedIpcHandlers(): () => void {
  const { approver, decide } = createStudioApprover(
    (channel, payload) => {
      const win = workbenchWindow();
      if (!win || win.isDestroyed()) return false;
      win.webContents.send(channel, payload);
      return win.webContents.id;
    },
    // Native, main-owned: the exact command line, where it runs, and the script digest.
    async (view) => {
      const win = workbenchWindow();
      const lines = [
        view.commandLine,
        "",
        `in: ${view.cwd}`,
        `asked by: ${view.requester} (${view.surface})`,
        ...(view.script ? [`script sha256: ${view.script.sha256}`] : []),
        ...(view.why ? ["", view.why] : []),
      ];
      const options = {
        type: "warning" as const,
        buttons: ["Run as administrator", "Deny"],
        defaultId: 1,
        cancelId: 1,
        message: "Run this command as root?",
        detail: lines.join("\n"),
      };
      const r =
        win && !win.isDestroyed()
          ? await dialog.showMessageBox(win, options)
          : await dialog.showMessageBox(options);
      return r.response === 0;
    },
  );
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
