// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/stores/toasts.ts — the app-wide notification queue.
 *
 * @prometheus/ui has shipped a `ToastViewport` since the first design pass, and nothing ever
 * pushed a toast: every background outcome (a download that finished or was blocked while the
 * user was on another screen, an install that failed, a package that would not remove) was
 * either written inline on a screen the user had left, or swallowed outright by a
 * `.catch(() => {})`. This store is the one place those outcomes go; `ToastHost` (App.tsx)
 * renders it.
 *
 * The queue rules are PURE (`enqueueToast`) so they are tested without React:
 *   - the same message (same `key`, or same tone+title+description) REPLACES its earlier copy
 *     instead of stacking — a retry loop must not bury the screen;
 *   - at most `MAX_TOASTS` are visible; the oldest goes first;
 *   - danger toasts stay longer (15 s, paused while hovered) because they report something the
 *     user has to act on; the rest fade after 6 s. Nothing is sticky by default — four sticky
 *     failures used to pile up over the screen.
 */

import type { ToastData, ToastTone } from "@prometheus/ui";
import { create } from "zustand";

export const MAX_TOASTS = 4;

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms before it fades (paused while hovered); 0 = until dismissed. Default: 15000 for danger,
   *  6000 otherwise. */
  duration?: number;
  /** identity for de-duplication (defaults to tone+title+description) */
  key?: string;
}

export interface QueuedToast extends ToastData {
  key: string;
}

let seq = 0;

export function toastKey(t: ToastInput): string {
  return t.key ?? `${t.tone ?? "info"}|${t.title}|${t.description ?? ""}`;
}

/** The queue after `t` arrives. Pure. */
export function enqueueToast(
  list: readonly QueuedToast[],
  t: ToastInput,
  id: string,
): QueuedToast[] {
  const key = toastKey(t);
  const tone = t.tone ?? "info";
  const next: QueuedToast = {
    id,
    key,
    title: t.title,
    tone,
    duration: t.duration ?? (tone === "danger" ? 15_000 : 6000),
    ...(t.description ? { description: t.description } : {}),
  };
  const rest = list.filter((x) => x.key !== key);
  return [...rest, next].slice(-MAX_TOASTS);
}

interface ToastState {
  toasts: QueuedToast[];
  push(t: ToastInput): string;
  dismiss(id: string): void;
  clear(): void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    seq += 1;
    const id = `toast-${seq}`;
    set((s) => ({ toasts: enqueueToast(s.toasts, t, id) }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Push a notification from anywhere in the renderer (no hook needed). */
export function notify(t: ToastInput): string {
  return useToastStore.getState().push(t);
}

/** The message of whatever a promise rejected with, for a toast's description. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { error?: unknown }).error === "string")
    return (err as { error: string }).error;
  return "unknown error";
}
