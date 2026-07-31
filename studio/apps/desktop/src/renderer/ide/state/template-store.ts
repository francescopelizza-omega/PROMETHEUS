/**
 * ide/state/template-store.ts — the persisted USER live/postfix/surround templates (APP-020).
 *
 * The DURABLE truth is the APP-017 keyed settings store (`templates.user`, global layer,
 * reached over `window.prometheus.settings`); template bodies carry `$`, backticks and
 * newlines, so JSON — never a shell/env round-trip — is the only safe serialization. This
 * zustand slice is the renderer-side CACHE the editor's completion/surround providers read
 * synchronously (an async IPC per keystroke is not viable): it HYDRATES from settings on
 * editor/settings mount and WRITES THROUGH on every add/remove, so a value survives restart.
 *
 * The merge math (`mergedTemplatesForLang`, consuming the kind-scoped `mergeTemplates`) lives
 * in state/templates.ts; validation/sanitization live in @prometheus/core/templates — this
 * store only holds the raw user array + derives the merged registry for a (kind, lang).
 *
 * Renderer-SANDBOXED (C5): zustand + @prometheus/core/templates (pure) +
 * window.prometheus.settings only.
 */

import type { LiveTemplateDef, LiveTemplateKind } from "@prometheus/core/templates";
import { sanitizeUserTemplates } from "@prometheus/core/templates";
import { create } from "zustand";

import { mergedTemplatesForLang } from "./templates.js";

/** The settings key the user template array persists at (a known schemaKey — the settings
 *  IPC gates get/set on `findNodeBySchemaKey`, so this must match tree.ts). */
export const TEMPLATES_SETTINGS_KEY = "templates.user";

function settingsApi(): Window["prometheus"]["settings"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.settings : undefined;
}

/** Stable identity of a user template: (kind, sorted languages, abbrev). Two entries with
 *  the same identity are the "same" template — an edit replaces, a create with a colliding
 *  identity upserts. A live `log`/[ts] and a postfix `log`/[ts] are DISTINCT (kind differs). */
export function templateKey(t: LiveTemplateDef): string {
  return `${t.kind}::${[...t.languages].sort().join(",")}::${t.abbrev}`;
}

export interface TemplateStore {
  /** the user's own templates (all kinds). */
  user: LiveTemplateDef[];
  hydrated: boolean;
  /** load the persisted user templates from the settings store (idempotent, fail-soft). */
  hydrate(workspaceRoot?: string): Promise<void>;
  /** add or replace a user template (by `templateKey`), then write through to settings. */
  upsert(t: LiveTemplateDef, workspaceRoot?: string): Promise<void>;
  /** remove a user template (by `templateKey`), then write through to settings. */
  remove(t: LiveTemplateDef, workspaceRoot?: string): Promise<void>;
  /** the MERGED registry for a (kind, language): seed under user (user overrides on
   *  (abbrev, language)). This is what the editor providers consume. */
  mergedFor(kind: LiveTemplateKind, lang: string): LiveTemplateDef[];
}

async function persist(user: LiveTemplateDef[], workspaceRoot?: string): Promise<void> {
  await settingsApi()
    ?.set(TEMPLATES_SETTINGS_KEY, user, "global", workspaceRoot)
    .catch(() => {});
}

export const useTemplateStore = create<TemplateStore>((set, get) => ({
  user: [],
  hydrated: false,

  hydrate: async (workspaceRoot): Promise<void> => {
    const api = settingsApi();
    if (!api) {
      set({ hydrated: true });
      return;
    }
    const r = await api.get(TEMPLATES_SETTINGS_KEY, workspaceRoot).catch(() => undefined);
    // sanitizeUserTemplates drops any malformed persisted row — never throws.
    set({ user: sanitizeUserTemplates(r?.ok ? r.value : undefined), hydrated: true });
  },

  upsert: async (t, workspaceRoot): Promise<void> => {
    const key = templateKey(t);
    const user = [...get().user.filter((u) => templateKey(u) !== key), t];
    set({ user });
    await persist(user, workspaceRoot);
  },

  remove: async (t, workspaceRoot): Promise<void> => {
    const key = templateKey(t);
    const user = get().user.filter((u) => templateKey(u) !== key);
    set({ user });
    await persist(user, workspaceRoot);
  },

  mergedFor: (kind, lang): LiveTemplateDef[] => mergedTemplatesForLang(kind, lang, get().user),
}));
