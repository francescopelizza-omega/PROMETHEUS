/**
 * AppearancePage.tsx — Settings ▸ Appearance (file 13 §3.2).
 *
 * The scheme grid (swatch tiles) + the live editor/chrome/terminal preview triptych +
 * sync/pinned + density + per-window apply + import + "create custom". Built on
 * @prometheus/ui's `themes` namespace (08's 20 builtins as the single source, the
 * loader/contrast gate) and the renderer's `useTheme()` (density). Selecting a scheme
 * flips the live CSS vars via `themes.applySchemeToRoot` (08 §6, no reload). No raw hex.
 */
import {
  Button,
  type ColorScheme,
  type DensityMode,
  Panel,
  exportTheme,
  getScheme,
  loadTheme,
  resolveScheme,
  schemeToTheme,
  themes,
} from "@prometheus/ui";
import { type ReactElement, useMemo, useState } from "react";

import { useTheme } from "../shell/ThemeProvider.js";
import { CustomThemeEditor } from "./CustomThemeEditor.js";
import {
  PREVIEW_CHROME,
  PREVIEW_EDITOR,
  PREVIEW_TERMINAL,
  type PreviewLine,
  swatchTile,
} from "./appearance-view.js";

function PreviewPane({
  title,
  lines,
}: { title: string; lines: readonly PreviewLine[] }): ReactElement {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        background: "var(--bg-inset)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md, 6px)",
        padding: "var(--space-3, 6px)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-small-size, 0.8125rem)",
      }}
    >
      <div style={{ color: "var(--text-secondary)", marginBottom: "var(--space-2, 4px)" }}>
        {title}
      </div>
      {lines.map((l) => (
        <div
          key={l.text}
          style={{ color: l.role ? `var(--${l.role})` : "var(--text-primary)", whiteSpace: "pre" }}
        >
          {l.text}
        </div>
      ))}
    </div>
  );
}

function SchemeTile({
  scheme,
  active,
  onSelect,
}: {
  scheme: ColorScheme;
  active: boolean;
  onSelect: () => void;
}): ReactElement {
  // resolveScheme returns the SemanticColors interface (no index signature) → flatten
  // to a plain string map for the pure swatchTile helper.
  const tile = useMemo(
    () => swatchTile(Object.fromEntries(Object.entries(resolveScheme(scheme)))),
    [scheme],
  );
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={`${scheme.name} (${scheme.base})${active ? " — active" : ""}`}
      style={{
        width: 104,
        textAlign: "left",
        padding: 0,
        cursor: "pointer",
        background: "var(--bg-surface)",
        border: `2px solid ${active ? "var(--brand)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius-md, 6px)",
        overflow: "hidden",
        fontFamily: "var(--font-ui)",
      }}
    >
      <div style={{ display: "flex", height: 36 }}>
        {tile.bars.map((bar, i) => (
          <div key={`${scheme.id}-bar-${i}`} style={{ flex: 1, background: bar }} />
        ))}
        <div style={{ width: 14, background: tile.accent }} />
      </div>
      <div
        style={{
          padding: "var(--space-2, 4px)",
          color: "var(--text-primary)",
          fontSize: "var(--text-small-size, 0.8125rem)",
        }}
      >
        {scheme.name} {scheme.id === "prometheus-dark" ? "★" : ""}
        {active ? " ✓" : ""}
        <div style={{ color: "var(--text-secondary)" }}>{scheme.base}</div>
      </div>
    </button>
  );
}

export interface AppearancePageProps {
  /** the window id (for per-window apply, §3.5); undefined ⇒ global. */
  windowId?: string;
  /** APP-094: the active workspace root — theme EXPORT writes there via the path-guarded fs IPC. */
  workspaceRoot?: string;
}

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Adapt a validated theme@1 doc → a ColorScheme (import install). */
function themeToScheme(theme: ReturnType<typeof loadTheme> & object): ColorScheme {
  return {
    id: theme.meta.id,
    name: theme.meta.label,
    base: theme.base,
    builtin: false,
    filled: true,
    tokens: { ...theme.uiTokens },
  };
}

/** The §3.2 Appearance settings page. */
export function AppearancePage({ windowId, workspaceRoot }: AppearancePageProps): ReactElement {
  const {
    density,
    setDensity,
    preference,
    activeSchemeId,
    setScheme,
    customSchemes,
    registerCustomScheme,
  } = useTheme();
  const [registry, setRegistry] = useState(() => themes.createThemeRegistry());
  const [perWindow, setPerWindow] = useState(false);
  const [editing, setEditing] = useState(false);
  // APP-094: the outcome of the last import/export (inline error / success note).
  const [ioStatus, setIoStatus] = useState<{ kind: "error" | "ok"; message: string } | null>(null);

  // the picker list = the 41 builtins + the persisted custom (imported/authored) schemes.
  const schemes = useMemo(
    () => [...registry.builtin, ...customSchemes],
    [registry.builtin, customSchemes],
  );
  const activeId = activeSchemeId ?? registry.active.global;
  const active = schemes.find((s) => s.id === activeId) ?? schemes[0];

  const apply = (scheme: ColorScheme): void => {
    setRegistry((r) =>
      themes.setActive(r, scheme.id, perWindow ? (windowId ?? "self") : undefined),
    );
    if (perWindow) {
      // per-window override: paint THIS root only, don't touch the global persisted scheme.
      themes.applySchemeToRoot(scheme, document.documentElement);
    } else {
      // global: hand ownership to ThemeProvider — it persists the id AND re-applies it on
      // every reload / density / OS change, so the scheme is no longer clobbered or lost.
      setScheme(scheme.id);
    }
  };

  // APP-094: export the ACTIVE scheme as a shareable theme@1 JSON via the path-guarded fs IPC.
  const onExport = (): void => {
    void (async () => {
      const api = ide();
      if (!api || !workspaceRoot) {
        setIoStatus({ kind: "error", message: "open a folder to export the theme" });
        return;
      }
      if (!active) return;
      const json = exportTheme(schemeToTheme(active));
      const uri = `file://${workspaceRoot}/${active.id}.theme.json`;
      const r = await api.fsWrite(uri, json).catch(() => undefined);
      setIoStatus(
        r?.ok
          ? { kind: "ok", message: `exported ${active.id}.theme.json` }
          : { kind: "error", message: r?.error ?? "export failed" },
      );
    })();
  };

  // APP-094: import a theme@1 JSON → validate (loadTheme) → install as a custom scheme through
  // ThemeProvider (persisted) + apply. On failure the active theme is UNTOUCHED (draft-only).
  const onImport = (): void => {
    void (async () => {
      const picked = await window.prometheus
        ?.fileOpen?.({ title: "Import theme JSON" })
        .catch(() => undefined);
      if (!picked?.ok || !picked.path) return; // cancelled
      const read = await ide()
        ?.fsRead(`file://${picked.path}`)
        .catch(() => undefined);
      if (!read?.ok || typeof read.text !== "string") {
        setIoStatus({ kind: "error", message: read?.error ?? "could not read the file" });
        return;
      }
      const theme = loadTheme(read.text);
      if (!theme) {
        setIoStatus({
          kind: "error",
          message: "invalid theme file (not a valid theme@1 document)",
        });
        return;
      }
      const scheme = themeToScheme(theme);
      registerCustomScheme(scheme);
      setScheme(scheme.id); // apply the imported scheme (global)
      setIoStatus({ kind: "ok", message: `imported "${scheme.name}"` });
    })();
  };

  if (editing) {
    return (
      <CustomThemeEditor
        baseScheme={active ?? schemes[0] ?? getScheme("prometheus-dark")}
        onCancel={() => setEditing(false)}
        onSaved={(file) => {
          // persist through ThemeProvider (survives reload) + apply the authored scheme.
          const scheme = themes.customFileToScheme(file);
          registerCustomScheme(scheme);
          setScheme(scheme.id);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <Panel title="Appearance" elevation="e1">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6, 12px)",
          fontFamily: "var(--font-ui)",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: "var(--space-8, 16px)",
            flexWrap: "wrap",
            alignItems: "center",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <span style={{ color: "var(--text-secondary)" }}>
            Theme follows OS:{" "}
            <strong style={{ color: "var(--text-primary)" }}>
              {preference === "system" ? "Sync" : "Pinned"}
            </strong>
          </span>
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2, 4px)" }}
          >
            Density:
            <select
              value={density}
              onChange={(e) => setDensity(e.currentTarget.value as DensityMode)}
              aria-label="Density"
              style={{
                background: "var(--bg-inset)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-sm, 4px)",
              }}
            >
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable</option>
            </select>
          </label>
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2, 4px)" }}
          >
            <input
              type="checkbox"
              checked={perWindow}
              onChange={(e) => setPerWindow(e.currentTarget.checked)}
            />
            Apply per-window
          </label>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3
            style={{
              margin: 0,
              fontSize: "var(--text-small-size, 0.8125rem)",
              color: "var(--text-secondary)",
            }}
          >
            COLOR SCHEMES
          </h3>
          <div style={{ display: "flex", gap: "var(--space-2, 4px)" }}>
            {/* APP-094: import a theme@1 JSON / export the active scheme. */}
            <Button variant="ghost" onClick={onImport}>
              ⭱ Import
            </Button>
            <Button variant="ghost" onClick={onExport}>
              ⭳ Export
            </Button>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              + Create custom
            </Button>
          </div>
        </div>

        {ioStatus && (
          <div
            role={ioStatus.kind === "error" ? "alert" : undefined}
            style={{
              padding: "var(--space-1, 2px) var(--space-3, 6px)",
              borderRadius: "var(--radius-sm, 4px)",
              background: "var(--bg-inset)",
              border: `1px solid var(--${ioStatus.kind === "error" ? "danger" : "ok"})`,
              color: `var(--${ioStatus.kind === "error" ? "danger" : "ok"})`,
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            {ioStatus.message}
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3, 6px)" }}>
          {schemes.map((scheme) => (
            <SchemeTile
              key={scheme.id}
              scheme={scheme}
              active={scheme.id === activeId}
              onSelect={() => apply(scheme)}
            />
          ))}
        </div>

        <h3
          style={{
            margin: 0,
            fontSize: "var(--text-small-size, 0.8125rem)",
            color: "var(--text-secondary)",
          }}
        >
          PREVIEW (live)
        </h3>
        <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
          <PreviewPane title="editor" lines={PREVIEW_EDITOR} />
          <PreviewPane title="chrome" lines={PREVIEW_CHROME} />
          <PreviewPane title="terminal" lines={PREVIEW_TERMINAL} />
        </div>

        <div style={{ display: "flex", gap: "var(--space-3, 6px)", justifyContent: "flex-end" }}>
          <Button variant="primary" onClick={() => active && apply(active)}>
            Set as default
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export default AppearancePage;
