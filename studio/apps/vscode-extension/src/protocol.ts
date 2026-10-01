// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * protocol.ts — the messages crossing the webview boundary.
 *
 * A VS Code webview is a sandboxed iframe reached ONLY by `postMessage`/`acquireVsCodeApi()`.
 * There is no shared module graph with the extension host and no synchronous call, so this
 * file is the whole contract, kept in one place so the two sides cannot drift.
 */

/** extension host → webview. */
export type ToWebview =
  | { type: "ready" }
  /** a user message echoed back, so the webview never has to trust its own optimistic render. */
  | { type: "user"; text: string }
  /** an assistant text delta, appended to the open assistant bubble. */
  | { type: "delta"; text: string }
  /** a thinking delta — rendered dimmed and discarded when the turn ends. */
  | { type: "reasoning"; text: string }
  /** a tool-activity line. */
  | { type: "tool"; note: string }
  /** a wrapper status line (round counter, retry notice). */
  | { type: "status"; text: string }
  /** the turn finished: close the bubble, re-enable the composer. */
  | { type: "done" }
  | { type: "error"; text: string }
  /** clear the transcript. */
  | { type: "reset" }
  /** enable/disable the composer while a turn runs. */
  | { type: "busy"; busy: boolean };

/** webview → extension host. */
export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "reset" }
  /** the user clicked Cancel while a turn is running. */
  | { type: "cancel" };
