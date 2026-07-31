/**
 * ide/state/editor-vision-store.ts — the zustand wrapper around the PURE vision toggles
 * (editor-vision.ts, APP-074). Loads from localStorage on init + persists on every change
 * (fail-soft), mirroring the ghost-text opt-in. The Monaco providers read the LIVE value via
 * `useEditorVisionStore.getState()` inside their `provide*` callbacks, so a toggle takes effect
 * without re-registering — a flipped-off provider returns [] and a `fireVisionChange()` bump
 * invalidates any cached lenses/folds.
 */

import { create } from "zustand";

import {
  VISION_KEY,
  type VisionToggles,
  defaultVisionToggles,
  parseVisionToggles,
  serializeVisionToggles,
} from "./editor-vision.js";

interface EditorVisionStore extends VisionToggles {
  toggle(key: keyof VisionToggles): void;
  set(key: keyof VisionToggles, value: boolean): void;
}

function load(): VisionToggles {
  if (typeof window === "undefined") return defaultVisionToggles();
  try {
    return parseVisionToggles(window.localStorage.getItem(VISION_KEY));
  } catch {
    return defaultVisionToggles();
  }
}

/** Listeners (the Monaco lens/folding providers) that must re-run when a toggle flips. */
const changeListeners = new Set<() => void>();
export function onVisionChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
export function fireVisionChange(): void {
  for (const fn of changeListeners) fn();
}

function persist(t: VisionToggles): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VISION_KEY, serializeVisionToggles(t));
  } catch {
    /* quota / private mode — toggle just won't persist this run */
  }
}

export const useEditorVisionStore = create<EditorVisionStore>((set, get) => ({
  ...load(),
  toggle: (key) => {
    set((s) => ({ [key]: !s[key] }) as Partial<EditorVisionStore>);
    const { folding, inlayHints, codeVision } = get();
    persist({ folding, inlayHints, codeVision });
    fireVisionChange();
  },
  set: (key, value) => {
    set({ [key]: value } as Partial<EditorVisionStore>);
    const { folding, inlayHints, codeVision } = get();
    persist({ folding, inlayHints, codeVision });
    fireVisionChange();
  },
}));
