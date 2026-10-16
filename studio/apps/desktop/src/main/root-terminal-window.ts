// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/root-terminal-window.ts — the window a program running as ROOT is shown in.
 *
 * "Open as administrator" used to stream the root program into the Disk space panel and take
 * its keys from that renderer over IPC — so any script running in the app's main page (a
 * compromised renderer, a hostile extension, a rendered model reply) was root's keyboard. This
 * window removes that:
 *
 *   - It is its own window, holding nothing but the root program's screen.
 *   - Its keys come from Electron's `before-input-event`, which the browser process raises for
 *     REAL keyboard input — page JavaScript cannot synthesise it. Each key is suppressed for the
 *     page (`preventDefault`) and handed to main, which alone decides what root receives. There
 *     is no IPC channel by which any renderer, this one included, can type into root.
 *   - Cmd (meta) combinations are left alone, so the app's menu shortcuts still work — Cmd+W
 *     closes the window, which ends the session.
 *   - It opens without taking focus: sudo's system password dialog is up at that moment, and
 *     must stay in front. It is focused when the program draws.
 *
 * Electron itself is injected (`createWindow`), so the key and lifecycle rules are unit-tested.
 */
import { IPC } from "../shared/ipc-contract.js";
import type { OpenRootTerminalWindow } from "./disk-space-ipc.js";
import type { KeyInput } from "./terminal-keys.js";

/** The slice of an Electron BrowserWindow this needs. */
export interface WindowLike {
  webContents: {
    id: number;
    send(channel: string, payload: unknown): void;
    on(
      event: "before-input-event",
      cb: (e: { preventDefault(): void }, input: KeyInput) => void,
    ): unknown;
  };
  isDestroyed(): boolean;
  showInactive(): void;
  show(): void;
  focus(): void;
  close(): void;
  once(event: "ready-to-show", cb: () => void): unknown;
  on(event: "closed", cb: () => void): unknown;
}

/** a page that never says it listens cannot make main hold output without bound */
const MAX_HELD = 10_000;

export function createRootTerminalWindowOpener(opts: {
  /** builds and loads the hardened window (admin-terminal.html) */
  createWindow: () => WindowLike;
}): OpenRootTerminalWindow {
  return ({ onKey, onClosed }) => {
    const win = opts.createWindow();
    const wc = win.webContents;
    let closedBySession = false;
    // held until the PAGE says it listens: did-finish-load fires before React has mounted and
    // subscribed, and the program's first screen used to be lost in that gap
    let ready = false;
    const pending: [string, unknown][] = [];

    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.meta) return;
      event.preventDefault();
      onKey(input);
    });
    win.once("ready-to-show", () => win.showInactive());
    win.on("closed", () => {
      if (!closedBySession) onClosed();
    });

    const send = (channel: string, payload: unknown): void => {
      if (win.isDestroyed()) return;
      if (ready) wc.send(channel, payload);
      else if (pending.length < MAX_HELD) pending.push([channel, payload]);
    };

    return {
      webContentsId: wc.id,
      data: (chunk) => send(IPC.diskAdminData, chunk),
      status: (text) => send(IPC.diskAdminStatus, text),
      focus: () => {
        if (win.isDestroyed()) return;
        win.show();
        win.focus();
      },
      ready: () => {
        if (ready || win.isDestroyed()) return;
        ready = true;
        for (const [channel, payload] of pending.splice(0)) wc.send(channel, payload);
      },
      close: () => {
        closedBySession = true;
        if (!win.isDestroyed()) win.close();
      },
    };
  };
}
