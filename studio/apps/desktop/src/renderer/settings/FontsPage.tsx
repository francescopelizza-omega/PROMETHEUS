/**
 * FontsPage.tsx — Settings ▸ Fonts (PyCharm-style editor + terminal font config).
 *
 * Two independent sections — Editor (Monaco) and Terminal (xterm) — each with a
 * family picker (bundled coding fonts + system fonts), size, line spacing, and a
 * ligatures toggle, exactly like PyCharm's Editor → Font / Console font settings.
 * Changes are LIVE (the editor + terminal re-apply instantly via useFontStore) and
 * persisted. Each section shows a live preview rendered in the chosen font so the
 * user sees the effect before leaving the page. No raw hex — tokens only.
 */
import { Button, Panel } from "@prometheus/ui";
import type { ReactElement } from "react";

import {
  MONO_FAMILIES,
  familyById,
  familyHasLigatures,
  resolveFontStack,
} from "../ide/fonts/registry.js";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type FontConfig,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  useFontStore,
} from "../ide/fonts/store.js";

const BUNDLED = MONO_FAMILIES.filter((f) => f.bundled);
const SYSTEM = MONO_FAMILIES.filter((f) => !f.bundled);

const labelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  // without a floor the label keeps its intrinsic width and overflows its grid area
  // the moment the track is allowed to shrink.
  minWidth: 0,
  gap: "var(--space-2, 4px)",
  fontSize: "var(--text-small-size, 0.8125rem)",
  color: "var(--text-secondary)",
};
const fieldStyle = {
  background: "var(--bg-inset)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  fontFamily: "var(--font-ui)",
};

/** Sample lines exercising ligature glyphs, digits, and brackets for the preview. */
const PREVIEW_LINES = [
  "const ok = a != b && x >= 0;  // 0O 1lI |",
  "arr.map(x => x * 2).filter(v => v !== null)",
  "if (a === b) return () => {}; /* -> <= >= == */",
];

function FontSection({
  title,
  hint,
  cfg,
  onPatch,
  onReset,
}: {
  title: string;
  hint: string;
  cfg: FontConfig;
  onPatch: (patch: Partial<FontConfig>) => void;
  onReset: () => void;
}): ReactElement {
  const ligCapable = familyHasLigatures(cfg.familyId);
  const fam = familyById(cfg.familyId);
  // ligatures preview via font-feature-settings (calt/liga), matching the toggle.
  const ligOn = cfg.ligatures && ligCapable;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h3
          style={{
            margin: 0,
            fontSize: "var(--text-small-size, 0.8125rem)",
            color: "var(--text-secondary)",
          }}
        >
          {title.toUpperCase()}
        </h3>
        <Button variant="secondary" onClick={onReset}>
          Reset to default
        </Button>
      </div>
      <div
        style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
      >
        {hint}
      </div>

      <div
        style={{
          display: "grid",
          // bare fr tracks floor at min-content — the widest <option> held the row open.
          gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)",
          gap: "var(--space-4, 8px)",
          alignItems: "end",
        }}
      >
        <label style={labelStyle}>
          Font family
          <select
            value={cfg.familyId}
            onChange={(e) => onPatch({ familyId: e.currentTarget.value })}
            aria-label={`${title} font family`}
            style={fieldStyle}
          >
            <optgroup label="Bundled (offline)">
              {BUNDLED.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                  {f.note ? ` — ${f.note}` : ""}
                  {f.ligatures ? " (ligatures)" : ""}
                </option>
              ))}
            </optgroup>
            <optgroup label="System (if installed)">
              {SYSTEM.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <label style={labelStyle}>
          Size (px)
          <input
            type="number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            value={cfg.size}
            onChange={(e) => onPatch({ size: Number(e.currentTarget.value) })}
            aria-label={`${title} font size`}
            style={fieldStyle}
          />
        </label>

        <label style={labelStyle}>
          Line spacing
          <input
            type="number"
            step={0.05}
            min={LINE_HEIGHT_MIN}
            max={LINE_HEIGHT_MAX}
            value={cfg.lineHeight}
            onChange={(e) => onPatch({ lineHeight: Number(e.currentTarget.value) })}
            aria-label={`${title} line spacing`}
            style={fieldStyle}
          />
        </label>
      </div>

      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-2, 4px)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          color: ligCapable ? "var(--text-primary)" : "var(--text-secondary)",
        }}
      >
        <input
          type="checkbox"
          checked={ligOn}
          disabled={!ligCapable}
          onChange={(e) => onPatch({ ligatures: e.currentTarget.checked })}
        />
        Enable ligatures
        {!ligCapable && (
          <span style={{ color: "var(--text-secondary)" }}>
            — {fam?.label ?? "this font"} has no ligatures
          </span>
        )}
      </label>

      {/* live preview in the chosen font */}
      <div
        style={{
          background: "var(--bg-inset)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md, 6px)",
          padding: "var(--space-3, 6px)",
          fontFamily: resolveFontStack(cfg.familyId),
          fontSize: cfg.size,
          lineHeight: cfg.lineHeight,
          fontFeatureSettings: ligOn ? '"calt" 1, "liga" 1' : '"calt" 0, "liga" 0',
          color: "var(--text-primary)",
          whiteSpace: "pre",
          overflowX: "auto",
        }}
      >
        {PREVIEW_LINES.join("\n")}
      </div>
    </div>
  );
}

/** The Settings ▸ Fonts page. */
export function FontsPage(): ReactElement {
  const editor = useFontStore((s) => s.editor);
  const terminal = useFontStore((s) => s.terminal);
  const setEditor = useFontStore((s) => s.setEditor);
  const setTerminal = useFontStore((s) => s.setTerminal);
  const resetEditor = useFontStore((s) => s.resetEditor);
  const resetTerminal = useFontStore((s) => s.resetTerminal);

  return (
    <Panel title="Fonts" elevation="e1">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-8, 16px)",
          fontFamily: "var(--font-ui)",
        }}
      >
        <FontSection
          title="Editor"
          hint="The code editor font (Monaco). Applies to open files, diffs, and code panels."
          cfg={editor}
          onPatch={setEditor}
          onReset={resetEditor}
        />
        <div style={{ height: 1, background: "var(--border-subtle)" }} />
        <FontSection
          title="Terminal"
          hint="The integrated terminal font (xterm). Set independently of the editor."
          cfg={terminal}
          onPatch={setTerminal}
          onReset={resetTerminal}
        />
      </div>
    </Panel>
  );
}

export default FontsPage;
