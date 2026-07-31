/**
 * FormatPage.tsx — Settings ▸ Formatting (APP-019).
 *
 * The format-on-save master toggle, an optimize-imports-on-save toggle, and a
 * per-language enable matrix. Every change WRITES THROUGH the format-store to the
 * APP-017 keyed settings IPC (global layer), so it persists across restart; the
 * editor's Cmd-S handler reads the same store synchronously. No raw hex — tokens only.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the format-store only.
 */
import { Panel } from "@prometheus/ui";
import { type ReactElement, useEffect } from "react";

import { FORMAT_LANG_IDS, useFormatStore } from "../ide/state/format-store.js";
import { useTabsStore } from "../ide/state/stores.js";

const LANG_LABEL: Record<string, string> = {
  python: "Python",
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  rust: "Rust",
  go: "Go",
};

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2, 4px)",
  fontSize: "var(--text-small-size, 0.8125rem)",
  color: "var(--text-primary)",
  padding: "var(--space-1, 2px) 0",
};

export function FormatPage(): ReactElement {
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot) ?? undefined;
  const onSave = useFormatStore((s) => s.onSave);
  const optimizeImportsOnSave = useFormatStore((s) => s.optimizeImportsOnSave);
  const byLang = useFormatStore((s) => s.byLang);
  const setOnSave = useFormatStore((s) => s.setOnSave);
  const setOptimizeImports = useFormatStore((s) => s.setOptimizeImports);
  const setLang = useFormatStore((s) => s.setLang);

  // hydrate from the settings store on mount (idempotent) so the toggles reflect the
  // persisted values, not the store's cold defaults.
  useEffect(() => {
    void useFormatStore.getState().hydrate(workspaceRoot);
  }, [workspaceRoot]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5, 10px)" }}>
      <Panel title="Format on Save" elevation="e1">
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={onSave}
            onChange={(e) => void setOnSave(e.currentTarget.checked, workspaceRoot)}
            aria-label="format on save"
          />
          <span>Reformat the file with the language server on save (Cmd-S)</span>
        </label>
        <label style={rowStyle}>
          <input
            type="checkbox"
            checked={optimizeImportsOnSave}
            onChange={(e) => void setOptimizeImports(e.currentTarget.checked, workspaceRoot)}
            aria-label="optimize imports on save"
          />
          <span>Also optimize imports (source.organizeImports) on save</span>
        </label>
        <p
          style={{
            margin: "var(--space-2, 4px) 0 0",
            fontSize: "0.72rem",
            color: "var(--text-secondary)",
          }}
        >
          A project <code>.editorconfig</code> is always honored (indent, EOL, trim trailing
          whitespace, final newline) independent of this toggle.
        </p>
      </Panel>

      <Panel title="Per-language" elevation="e1">
        <p
          style={{
            margin: "0 0 var(--space-2, 4px)",
            fontSize: "0.72rem",
            color: "var(--text-secondary)",
          }}
        >
          When Format on Save is on, disable it for individual languages here.
        </p>
        {FORMAT_LANG_IDS.map((id) => (
          <label key={id} style={rowStyle}>
            <input
              type="checkbox"
              checked={byLang[id] !== false}
              disabled={!onSave}
              onChange={(e) => void setLang(id, e.currentTarget.checked, workspaceRoot)}
              aria-label={`format on save ${id}`}
            />
            <span>{LANG_LABEL[id] ?? id}</span>
          </label>
        ))}
      </Panel>
    </div>
  );
}

export default FormatPage;
