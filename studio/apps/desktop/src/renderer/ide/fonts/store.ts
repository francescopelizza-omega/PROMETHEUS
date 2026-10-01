// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/fonts/store.ts — the PyCharm-style font settings store (editor + terminal).
 *
 * Two independent font configs — one for the code editor (Monaco), one for the
 * integrated terminal (xterm) — each with family / size / line-height / ligatures,
 * exactly like PyCharm's Editor → Font and Console/Terminal font settings. The
 * store is persisted to localStorage (fail-soft) mirroring `useAiSessionStore`
 * (ide/state/stores.ts), and it drives the `--font-mono` CSS var at runtime so
 * every CSS-styled code surface (search, git, markdown) follows the editor font.
 *
 * Consumers read a config and resolve a concrete font-family STRING via the
 * registry (never a CSS `var()` — Monaco/xterm render to a canvas that does not
 * resolve custom properties). See EditorPane.tsx / Terminal.tsx.
 */

import { create } from "zustand";

import {
  DEFAULT_FONT_FAMILY_ID,
  familyById,
  familyHasLigatures,
  resolveFontStack,
} from "./registry.js";

/** One font surface's config (editor or terminal). */
export interface FontConfig {
  /** family id into the registry (MONO_FAMILIES). */
  familyId: string;
  /** font size in px. */
  size: number;
  /** line-height MULTIPLIER of the font size (Monaco/xterm both accept a ratio). */
  lineHeight: number;
  /** enable programming ligatures (only takes effect if the family supports them). */
  ligatures: boolean;
}

/** Bounds shared by both surfaces (matches sane editor limits). */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const LINE_HEIGHT_MIN = 1.0;
export const LINE_HEIGHT_MAX = 2.5;

/** PyCharm-like defaults: JetBrains Mono, 13px, comfortable spacing, ligatures off. */
export const DEFAULT_EDITOR_FONT: FontConfig = {
  familyId: DEFAULT_FONT_FAMILY_ID,
  size: 13,
  lineHeight: 1.2,
  ligatures: false,
};
export const DEFAULT_TERMINAL_FONT: FontConfig = {
  familyId: DEFAULT_FONT_FAMILY_ID,
  size: 13,
  lineHeight: 1.2,
  ligatures: false,
};

export interface FontStore {
  editor: FontConfig;
  terminal: FontConfig;
  /** patch the editor font config (partial). */
  setEditor(patch: Partial<FontConfig>): void;
  /** patch the terminal font config (partial). */
  setTerminal(patch: Partial<FontConfig>): void;
  /** restore the editor config to the PyCharm defaults. */
  resetEditor(): void;
  /** restore the terminal config to the PyCharm defaults. */
  resetTerminal(): void;
}

const STORAGE_KEY = "prometheus.fonts";

/** Clamp a number to [min,max]; fall back to `dflt` when not finite. */
function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.min(max, Math.max(min, n));
}

/** Validate one persisted config against the registry + bounds (fail-soft). */
function coerceConfig(raw: unknown, dflt: FontConfig): FontConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const familyId =
    typeof o.familyId === "string" && familyById(o.familyId) ? o.familyId : dflt.familyId;
  return {
    familyId,
    size: clampNum(o.size, FONT_SIZE_MIN, FONT_SIZE_MAX, dflt.size),
    lineHeight: clampNum(o.lineHeight, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, dflt.lineHeight),
    // a ligature request only sticks if the chosen family actually supports it.
    ligatures:
      typeof o.ligatures === "boolean" ? o.ligatures && familyHasLigatures(familyId) : false,
  };
}

/** Load persisted font settings (validated; fail-soft → defaults). */
function loadFonts(): { editor: FontConfig; terminal: FontConfig } {
  const dflt = { editor: DEFAULT_EDITOR_FONT, terminal: DEFAULT_TERMINAL_FONT };
  if (typeof window === "undefined") return dflt;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return dflt;
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      editor: coerceConfig(o.editor, DEFAULT_EDITOR_FONT),
      terminal: coerceConfig(o.terminal, DEFAULT_TERMINAL_FONT),
    };
  } catch {
    return dflt;
  }
}

/** Re-coerce a patched config so a family change that drops ligature support, or an
 *  out-of-range size, is normalised the same way a persisted value would be. */
function applyPatch(current: FontConfig, patch: Partial<FontConfig>): FontConfig {
  return coerceConfig({ ...current, ...patch }, current);
}

export const useFontStore = create<FontStore>((set) => ({
  ...loadFonts(),
  setEditor: (patch): void => set((s) => ({ editor: applyPatch(s.editor, patch) })),
  setTerminal: (patch): void => set((s) => ({ terminal: applyPatch(s.terminal, patch) })),
  resetEditor: (): void => set({ editor: { ...DEFAULT_EDITOR_FONT } }),
  resetTerminal: (): void => set({ terminal: { ...DEFAULT_TERMINAL_FONT } }),
}));

/** Push the editor family into `--font-mono` so CSS-styled code surfaces follow it. */
function applyEditorFontVar(editor: FontConfig): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--font-mono", resolveFontStack(editor.familyId));
}

// Persist on every change + keep the `--font-mono` CSS var in sync with the editor
// font (mirrors the ThemeProvider setProperty pattern). Applied once on load too.
if (typeof window !== "undefined") {
  applyEditorFontVar(useFontStore.getState().editor);
  let lastEditorFamily = useFontStore.getState().editor.familyId;
  useFontStore.subscribe((s) => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ editor: s.editor, terminal: s.terminal }),
      );
    } catch {
      /* private mode / quota — settings just won't persist this run. */
    }
    if (s.editor.familyId !== lastEditorFamily) {
      lastEditorFamily = s.editor.familyId;
      applyEditorFontVar(s.editor);
    }
  });
}
