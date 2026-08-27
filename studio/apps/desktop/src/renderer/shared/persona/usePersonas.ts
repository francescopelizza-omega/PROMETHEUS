/**
 * renderer/shared/persona/usePersonas.ts — Settings ▸ Personas' data hook.
 *
 * Mirrors useModelHealth.ts's exact alive-ref/interval/cleanup shape (Model Health is also
 * global, not per-workspace, and also wants a LIVE view — a user who leaves this page open
 * should see a friend's import land without navigating away and back). Every mutating call
 * (`importText`/`importPath`/`remove`) also triggers an immediate `refresh()` of its own,
 * rather than making the caller wait for the next 5s poll tick to see its own change reflected.
 *
 * WHY THIS FILE DOESN'T IMPORT `PrometheusApi` FROM shared/ipc-contract.ts: this feature's IPC
 * surface (`window.prometheus.persona.*`) is being wired into ipc-contract.ts + preload/api.ts
 * by a separate, parallel change at the same time as this file, specifically so two changes
 * don't touch the same shared files at once. Typing this hook against the ambient
 * `PrometheusApi`/`Window` shape would only compile once that lands, so the bridge shape is
 * declared locally instead — structurally identical to the real `persona` field, and casting
 * through `unknown` rather than the ambient type keeps this file buildable independent of
 * landing order in either direction.
 *
 * Every access below reads `globalThis.window?.prometheus?.…` — a PROPERTY read off
 * `globalThis` — and never a bare `window.prometheus…` identifier reference: this hook (like
 * every renderer module) can be imported under node:test's plain Node environment, which has no
 * global `window` at all, and a bare `window` reference throws ReferenceError before optional
 * chaining ever gets a chance to short-circuit it.
 *
 * Renderer-SANDBOXED (C5): react + the local `PersonaFileView`/`PersonaScope` view types +
 * `window.prometheus.persona` only.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { PersonaFileView, PersonaScope } from "../../settings/persona-view.js";

const POLL_MS = 5000;

/** Response to `persona.list()`. */
interface PersonaListResult {
  ok: boolean;
  personas?: PersonaFileView[];
  error?: string;
}

/** Response to `persona.export(name)`. */
interface PersonaExportResult {
  ok: boolean;
  markdown?: string;
  scope?: PersonaScope;
  error?: string;
}

/** Response to `persona.importText(...)` / `persona.importPath(...)`. */
interface PersonaMutateResult {
  ok: boolean;
  name?: string;
  replaced?: boolean;
  error?: string;
}

/** Response to `persona.remove(name)`. */
interface PersonaRemoveResult {
  ok: boolean;
  error?: string;
}

/** The persona-sharing slice of the preload bridge — see the file header for why this is a
 *  local, structural shape rather than an import from shared/ipc-contract.ts. */
interface PersonaApiBridge {
  list(): Promise<PersonaListResult>;
  export(name: string): Promise<PersonaExportResult>;
  importText(suggestedName: string, markdown: string): Promise<PersonaMutateResult>;
  importPath(path: string): Promise<PersonaMutateResult>;
  remove(name: string): Promise<PersonaRemoveResult>;
}

function personaBridge(): PersonaApiBridge | undefined {
  return (globalThis as unknown as { window?: { prometheus?: { persona?: PersonaApiBridge } } })
    .window?.prometheus?.persona;
}

export interface UsePersonasResult {
  personas: PersonaFileView[];
  loading: boolean;
  error: string | undefined;
  /** Re-fetch immediately, without waiting for the next poll tick. */
  refresh: () => void;
  /** Export one of the user's OWN personas as raw markdown, or `undefined` on failure. */
  exportOne: (name: string) => Promise<string | undefined>;
  /** Import pasted markdown text under a suggested name. */
  importText: (suggestedName: string, markdown: string) => Promise<{ ok: boolean; error?: string }>;
  /** Import a local .md file the user chose via the native file picker. */
  importPath: (path: string) => Promise<{ ok: boolean; error?: string }>;
  /** Remove an imported persona by name. Resolves `true` iff it was actually removed. */
  remove: (name: string) => Promise<boolean>;
}

/** Alphabetical by name — stable, predictable ordering regardless of scan order. Pure +
 *  exported for its own test coverage. */
export function sortByName(personas: readonly PersonaFileView[]): PersonaFileView[] {
  return [...personas].sort((a, b) => a.name.localeCompare(b.name));
}

export function usePersonas(): UsePersonasResult {
  const [personas, setPersonas] = useState<PersonaFileView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  // guards a poll tick landing after unmount from calling setState on a gone component.
  const alive = useRef(true);

  const load = useCallback(async () => {
    const res = await personaBridge()?.list();
    if (!alive.current) return;
    if (!res || !res.ok) {
      setError(res?.error ?? "persona IPC unavailable");
      setLoading(false);
      return;
    }
    setError(undefined);
    setPersonas(sortByName(res.personas ?? []));
    setLoading(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  const exportOne = useCallback(async (name: string): Promise<string | undefined> => {
    const res = await personaBridge()?.export(name);
    return res?.ok ? res.markdown : undefined;
  }, []);

  const importText = useCallback(
    async (suggestedName: string, markdown: string): Promise<{ ok: boolean; error?: string }> => {
      const res = await personaBridge()?.importText(suggestedName, markdown);
      if (!res) return { ok: false, error: "persona IPC unavailable" };
      if (res.ok) refresh();
      return { ok: res.ok, error: res.error };
    },
    [refresh],
  );

  const importPath = useCallback(
    async (path: string): Promise<{ ok: boolean; error?: string }> => {
      const res = await personaBridge()?.importPath(path);
      if (!res) return { ok: false, error: "persona IPC unavailable" };
      if (res.ok) refresh();
      return { ok: res.ok, error: res.error };
    },
    [refresh],
  );

  const remove = useCallback(
    async (name: string): Promise<boolean> => {
      const res = await personaBridge()?.remove(name);
      const ok = res?.ok ?? false;
      if (ok) refresh();
      return ok;
    },
    [refresh],
  );

  return { personas, loading, error, refresh, exportOne, importText, importPath, remove };
}

export default usePersonas;
