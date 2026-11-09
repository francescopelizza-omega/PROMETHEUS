// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ipc-sender-guard.ts — every IPC message is checked for WHO sent it (security review S11).
 *
 * Three windows load the same preload, so all three could reach all ~300 channels: the main
 * workbench, the tear-out floating terminal, and the root (admin) terminal. The admin window
 * renders the output of a program running as root — attacker-influenced bytes such as file
 * names — through xterm, and with the full bridge behind it, a renderer bug there would have
 * been a bug with every privilege the workbench has. And no handler looked at
 * `event.senderFrame` at all, so a frame that was not one of ours (a sub-frame, a page the
 * window navigated to, a frame already torn down) was answered like the app itself.
 *
 * So, before any handler is registered, `installIpcSenderGuard` wraps `ipcMain.handle`/`on`
 * (and their `*Once` twins). Each call is accepted only when:
 *   1. the sending frame still exists and is a TOP-LEVEL frame;
 *   2. its URL is one of the app's own renderer pages — a `file:` URL inside the packaged
 *      renderer directory, or (dev only) the exact origin of the Vite dev server;
 *   3. the page is allowed that channel: the workbench may use every channel, the two
 *      terminal windows only the handful their UI actually calls.
 * A refused `invoke` rejects with the reason; a refused `send` is dropped and logged.
 *
 * The classification is PURE (`classifySenderUrl`, `senderMayUse`) and unit-tested; the
 * install step is the only part that touches Electron.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { IPC } from "../shared/ipc-contract.js";

export type SenderPage = "workbench" | "floating-terminal" | "admin-terminal";

const PAGE_BY_FILE: Record<string, SenderPage> = {
  "": "workbench",
  "index.html": "workbench",
  "floating-terminal.html": "floating-terminal",
  "admin-terminal.html": "admin-terminal",
};

/**
 * The channels each secondary window may use. Derived from what their components call:
 * FloatingTerminalWindow (ptyWrite / floatingTerminal.close, plus resize/kill for the pty it
 * shows) and RootTerminalView (adminReady / adminResize / adminStop). Main → renderer pushes (pty.data,
 * admin data/status) are not IPC handlers and are unaffected.
 */
const PAGE_CHANNELS: Record<Exclude<SenderPage, "workbench">, ReadonlySet<string>> = {
  "floating-terminal": new Set([
    IPC.idePtyWrite,
    IPC.idePtyResize,
    IPC.idePtyKill,
    IPC.ideFloatingTerminalClose,
  ]),
  // RootTerminalView: Ready, Resize, and its Stop button. Keys never travel over IPC at all —
  // main reads them from the keyboard (before-input-event).
  "admin-terminal": new Set([IPC.diskAdminReady, IPC.diskAdminResize, IPC.diskAdminStop]),
};

export interface SenderGuardOptions {
  /** directories the packaged renderer pages may live in (out/renderer, by every spelling) */
  rendererDirs: readonly string[];
  /** the Vite dev server URL — set only in an `electron-vite dev` run */
  devUrl?: string;
}

/** `.asar.unpacked` and `.asar` name the same tree; compare them as one. */
function canonical(p: string): string {
  return resolve(p).replace(/\.asar\.unpacked(?=[\\/]|$)/g, ".asar");
}

/** Which of the app's pages a frame URL is, or null when it is none of them. */
export function classifySenderUrl(url: string, opts: SenderGuardOptions): SenderPage | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let file: string;
  if (opts.devUrl) {
    let dev: URL;
    try {
      dev = new URL(opts.devUrl);
    } catch {
      return null;
    }
    // exact ORIGIN, never a string prefix: `http://localhost:5173.evil.example` must not match
    if (u.origin !== dev.origin) return null;
    file = u.pathname.replace(/^\/+/, "");
  } else {
    if (u.protocol !== "file:") return null;
    let path: string;
    try {
      path = canonical(fileURLToPath(u));
    } catch {
      return null;
    }
    const inside = opts.rendererDirs
      .map((d) => relative(canonical(d), path))
      .find((rel) => rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
    if (inside === undefined) return null;
    file = inside.split(/[\\/]/).join("/");
  }
  return Object.hasOwn(PAGE_BY_FILE, file) ? (PAGE_BY_FILE[file] as SenderPage) : null;
}

/** May `page` use `channel`? The workbench may use all of them. */
export function senderMayUse(page: SenderPage, channel: string): boolean {
  if (page === "workbench") return true;
  return PAGE_CHANNELS[page].has(channel);
}

interface FrameLike {
  url: string;
  parent: unknown;
  isDestroyed?: () => boolean;
}

/** Why an IPC event must be refused, or null when it may proceed. */
export function senderRefusal(
  channel: string,
  event: { senderFrame?: FrameLike | null },
  opts: SenderGuardOptions,
): string | null {
  const frame = event.senderFrame;
  if (!frame || frame.isDestroyed?.()) return "the sending frame no longer exists";
  if (frame.parent) return "sent from a sub-frame";
  const page = classifySenderUrl(frame.url, opts);
  if (!page) return "sent from a page that is not part of Prometheus";
  if (!senderMayUse(page, channel)) return `the ${page} window may not use ${channel}`;
  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: Electron's own listener signature is any-typed
type Listener = (event: any, ...args: any[]) => unknown;
interface IpcLike {
  handle(channel: string, listener: Listener): void;
  handleOnce?(channel: string, listener: Listener): void;
  on(channel: string, listener: Listener): unknown;
  once?(channel: string, listener: Listener): unknown;
}

let installed = false;
let installedOpts: SenderGuardOptions | undefined;

/**
 * Which of our pages a webContents shows (by its URL), or null. Used to address something only
 * the WORKBENCH can answer — e.g. the privileged approval card: sent to a focused terminal
 * window, the reply was (rightly) refused by this guard and the request timed out.
 */
export function pageOfUrl(url: string): SenderPage | null {
  return installedOpts ? classifySenderUrl(url, installedOpts) : null;
}

/** Wrap ipcMain so every handler registered AFTER this call is sender-checked. Idempotent. */
export function installIpcSenderGuard(
  ipc: IpcLike,
  opts: SenderGuardOptions,
  log: (msg: string) => void = (m) => console.warn(m),
): void {
  if (installed) return;
  installed = true;
  installedOpts = opts;
  const guardInvoke =
    (channel: string, listener: Listener): Listener =>
    (event, ...args) => {
      const why = senderRefusal(channel, event, opts);
      if (why) {
        log(`[ipc] refused ${channel}: ${why}`);
        throw new Error(`IPC ${channel} refused: ${why}`);
      }
      return listener(event, ...args);
    };
  const guardSend =
    (channel: string, listener: Listener): Listener =>
    (event, ...args) => {
      const why = senderRefusal(channel, event, opts);
      if (why) {
        log(`[ipc] dropped ${channel}: ${why}`);
        return undefined;
      }
      return listener(event, ...args);
    };

  const handle = ipc.handle.bind(ipc);
  ipc.handle = (channel, listener) => handle(channel, guardInvoke(channel, listener));
  if (ipc.handleOnce) {
    const handleOnce = ipc.handleOnce.bind(ipc);
    ipc.handleOnce = (channel, listener) => handleOnce(channel, guardInvoke(channel, listener));
  }
  const on = ipc.on.bind(ipc);
  ipc.on = (channel, listener) => on(channel, guardSend(channel, listener));
  if (ipc.once) {
    const once = ipc.once.bind(ipc);
    ipc.once = (channel, listener) => once(channel, guardSend(channel, listener));
  }
}

/** test-only: allow a fresh install in the next test */
export function resetIpcSenderGuardForTests(): void {
  installed = false;
  installedOpts = undefined;
}
