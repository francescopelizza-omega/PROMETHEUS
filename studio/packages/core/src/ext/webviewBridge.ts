// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ext/webviewBridge.ts — the sandboxed-webview RPC SEAM (file 09 §5.2, interface-only).
 *
 * Extension panels render in sandboxed webviews (contextIsolation:true,
 * nodeIntegration:false, CSP) and talk to their extension over a postMessage RPC.
 * Core defines the message shape + the bridge contract; the desktop main wires it to
 * Electron's webContents/ipc. Pure types — no electron import.
 */
import type { Disposable } from "./context.js";

/** A message crossing the webview ⇄ extension boundary. */
export interface WebviewMessage {
  /** RPC method or event name. */
  type: string;
  /** correlation id for request/response pairs (optional for events). */
  id?: string;
  payload?: unknown;
  error?: string;
}

/** The bridge the host implements to talk to a panel's webview. */
export interface WebviewBridge {
  /** post a message INTO a panel's webview. */
  post(panelId: string, msg: WebviewMessage): void;
  /** subscribe to messages FROM a panel's webview. */
  onMessage(panelId: string, cb: (msg: WebviewMessage) => void): Disposable;
}

/** Validate an inbound webview message shape (defensive — never trust the webview). */
export function isWebviewMessage(v: unknown): v is WebviewMessage {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}
