/**
 * shell/update-view.ts — PURE state machine for the update banner (APP-005).
 *
 * JSX-free (rightrail-view/sidebar-view convention) so node:test pins the
 * available → downloading → ready transitions. The machine is UX ONLY: the
 * ask-before-download / never-auto-install gates live in MAIN (update-policy);
 * install is reachable strictly in the "ready" phase.
 */

import type { UpdateAvailableInfo, UpdateProgressInfo } from "../../shared/ipc-contract.js";

export type UpdatePhase = "idle" | "available" | "downloading" | "ready";

export interface UpdateState {
  phase: UpdatePhase;
  /** the offered version (from update:available or a check() re-poll). */
  version: string | null;
  /** whole 0-100 during download (floats from electron-updater are rounded). */
  percent: number;
  /** a failed download's message — shown inline, phase falls back to "available". */
  error: string | null;
}

export const UPDATE_IDLE: UpdateState = { phase: "idle", version: null, percent: 0, error: null };

/** update:available event, or a check() that returned a non-null version (the
 *  re-poll path for events lost before the renderer subscribed). Ignored once a
 *  download is in flight or staged — a repeat announce must not reset progress. */
export function updateOnAvailable(s: UpdateState, info: UpdateAvailableInfo): UpdateState {
  if (s.phase === "downloading" || s.phase === "ready") return s;
  const version = typeof info?.version === "string" && info.version ? info.version : null;
  if (!version) return s; // nothing announced → no banner (never invent a state)
  return { phase: "available", version, percent: 0, error: null };
}

/** the user clicked Download. */
export function updateOnDownloadStart(s: UpdateState): UpdateState {
  if (s.phase !== "available") return s;
  return { ...s, phase: "downloading", percent: 0, error: null };
}

/** update:progress — percent arrives as a FLOAT 0-100; clamp + round for display. */
export function updateOnProgress(s: UpdateState, p: UpdateProgressInfo): UpdateState {
  if (s.phase !== "downloading") return s;
  const raw = typeof p?.percent === "number" && Number.isFinite(p.percent) ? p.percent : 0;
  return { ...s, percent: Math.min(100, Math.max(0, Math.round(raw))) };
}

/** a download() that resolved ok:false — back to "available" with the message. */
export function updateOnDownloadError(s: UpdateState, error: string): UpdateState {
  if (s.phase !== "downloading") return s;
  return { ...s, phase: "available", percent: 0, error: error || "download failed" };
}

/** update:ready (update-downloaded) — "Restart to update" becomes the only action. */
export function updateOnReady(s: UpdateState): UpdateState {
  if (s.phase === "idle") return s; // a ready with no prior announce is not renderable
  return { ...s, phase: "ready", percent: 100, error: null };
}

/** dismiss hides the banner; a later check()/announce can resurface it. */
export function updateOnDismiss(_s: UpdateState): UpdateState {
  return UPDATE_IDLE;
}

/** the banner's action label per phase (null = no action button). */
export function updateActionLabel(s: UpdateState): string | null {
  switch (s.phase) {
    case "available":
      return "Download";
    case "downloading":
      return `${s.percent}%`;
    case "ready":
      return "Restart to update";
    default:
      return null;
  }
}
