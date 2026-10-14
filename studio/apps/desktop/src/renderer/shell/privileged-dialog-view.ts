// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/shell/privileged-dialog-view.ts — the pure half of the privileged approval dialog.
 *
 * Requests queue (two privileged commands asked at once are two decisions, never one), the
 * head is shown, and a request leaves the queue when it is answered or when main closes it
 * (timed out). Approve is enabled only when no phrase is required or the typed phrase matches.
 */
import type { PrivilegedPromptView } from "../../shared/ipc-contract.js";

export type QueueEvent =
  | { type: "request"; view: PrivilegedPromptView }
  | { type: "close"; id: string }
  | { type: "answered"; id: string };

export function reduceQueue(
  queue: readonly PrivilegedPromptView[],
  ev: QueueEvent,
): PrivilegedPromptView[] {
  if (ev.type === "request") {
    return queue.some((v) => v.id === ev.view.id) ? [...queue] : [...queue, ev.view];
  }
  return queue.filter((v) => v.id !== ev.id);
}

export function canApprove(view: PrivilegedPromptView, typed: string): boolean {
  return !view.phrase || typed.trim() === view.phrase;
}

export function countdownLabel(remainingMs: number): string {
  const s = Math.max(0, Math.ceil(remainingMs / 1000));
  return `auto-deny in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
