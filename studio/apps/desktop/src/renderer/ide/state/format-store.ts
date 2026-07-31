/**
 * ide/state/format-store.ts — the live format-on-save policy for the editor (APP-019).
 *
 * The DURABLE truth is the APP-017 keyed settings store (global/workspace JSON layers,
 * reached over `window.prometheus.settings`). This zustand slice is the renderer-side
 * CACHE the Cmd-S handler reads synchronously (an async IPC round-trip per keystroke of
 * a save is not viable): it HYDRATES from settings on editor/settings mount and
 * WRITES THROUGH to settings on every toggle, so a value still survives a restart.
 *
 * The decision math (`formatOnSaveEnabled`) lives in @prometheus/core/format — this
 * store only holds the raw flags + derives a `FormatPolicy` for it. The languages that
 * get a per-language flag are FORMAT_LANG_IDS (mirrors core's FORMAT_LANGS; the renderer
 * keeps its own copy per the C5 no-core-root-import rule).
 *
 * Renderer-SANDBOXED (C5): zustand + window.prometheus.settings only.
 */

import type { FormatPolicy } from "@prometheus/core/format";
import { create } from "zustand";

/** The languages exposed as `format.lang.<id>` toggles (mirrors core FORMAT_LANGS). */
export const FORMAT_LANG_IDS = [
  "python",
  "typescript",
  "javascript",
  "json",
  "rust",
  "go",
] as const;

function settingsApi(): Window["prometheus"]["settings"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.settings : undefined;
}

export interface FormatStore {
  onSave: boolean;
  optimizeImportsOnSave: boolean;
  /** langId → enabled (false suppresses format-on-save for that language). */
  byLang: Record<string, boolean>;
  hydrated: boolean;
  /** load the current effective values from the settings store (idempotent). */
  hydrate(workspaceRoot?: string): Promise<void>;
  /** persist a format flag to the GLOBAL layer + update the cache (write-through). */
  setOnSave(v: boolean, workspaceRoot?: string): Promise<void>;
  setOptimizeImports(v: boolean, workspaceRoot?: string): Promise<void>;
  setLang(langId: string, v: boolean, workspaceRoot?: string): Promise<void>;
  /** derive the core FormatPolicy the pure `formatOnSaveEnabled` gate consumes. */
  policy(): FormatPolicy;
}

async function getBool(
  api: NonNullable<ReturnType<typeof settingsApi>>,
  key: string,
  fallback: boolean,
  workspaceRoot?: string,
): Promise<boolean> {
  const r = await api.get(key, workspaceRoot).catch(() => undefined);
  return r?.ok && typeof r.value === "boolean" ? r.value : fallback;
}

export const useFormatStore = create<FormatStore>((set, get) => ({
  onSave: false,
  optimizeImportsOnSave: false,
  byLang: Object.fromEntries(FORMAT_LANG_IDS.map((id) => [id, true])),
  hydrated: false,

  hydrate: async (workspaceRoot): Promise<void> => {
    const api = settingsApi();
    if (!api) {
      set({ hydrated: true });
      return;
    }
    const onSave = await getBool(api, "format.onSave", false, workspaceRoot);
    const optimizeImportsOnSave = await getBool(
      api,
      "format.optimizeImportsOnSave",
      false,
      workspaceRoot,
    );
    const byLang: Record<string, boolean> = {};
    for (const id of FORMAT_LANG_IDS) {
      byLang[id] = await getBool(api, `format.lang.${id}`, true, workspaceRoot);
    }
    set({ onSave, optimizeImportsOnSave, byLang, hydrated: true });
  },

  setOnSave: async (v, workspaceRoot): Promise<void> => {
    set({ onSave: v });
    await settingsApi()
      ?.set("format.onSave", v, "global", workspaceRoot)
      .catch(() => {});
  },
  setOptimizeImports: async (v, workspaceRoot): Promise<void> => {
    set({ optimizeImportsOnSave: v });
    await settingsApi()
      ?.set("format.optimizeImportsOnSave", v, "global", workspaceRoot)
      .catch(() => {});
  },
  setLang: async (langId, v, workspaceRoot): Promise<void> => {
    set((s) => ({ byLang: { ...s.byLang, [langId]: v } }));
    await settingsApi()
      ?.set(`format.lang.${langId}`, v, "global", workspaceRoot)
      .catch(() => {});
  },

  policy: (): FormatPolicy => {
    const s = get();
    return {
      onSave: s.onSave,
      afterAiEdit: false,
      optimizeImportsOnSave: s.optimizeImportsOnSave,
      byLang: s.byLang,
    };
  },
}));
