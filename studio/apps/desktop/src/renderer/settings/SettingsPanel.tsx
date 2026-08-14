/**
 * settings/SettingsPanel.tsx — the two-pane Settings surface (file 13 §2, leap #5b).
 *
 * A left category nav (Appearance · Keymap) + the selected page on the right, mounted in
 * the §6 settings overlay. The Keymap page is fed entirely from the renderer COMMAND
 * REGISTRY (leap #1) + the well-known editor chords — no core IPC needed (the registry
 * is the single source of the shell's keybindings). The full core-served settings-KEY
 * tree (SettingsTree.tsx, with ownerFile provenance) still awaits a core settings IPC;
 * this rescues the finished AppearancePage + KeymapPage from being orphaned.
 *
 * Renderer-SANDBOXED (C5): react + the registry + the pages only.
 */

import {
  BINDABLE_COMMANDS,
  BUILTIN_KEYMAPS,
  type KeyBinding,
  type Keymap,
  applyUserBinding,
  clearUserBinding,
  conflictsForCandidate,
  detectConflicts,
  exportKeymap,
  getKeymap,
  importKeymap,
  mergeUserBindings,
  resolveBindings,
} from "@prometheus/core/keymap";
import { type CSSProperties, type ReactElement, useMemo, useState } from "react";

import { AppearancePage } from "./AppearancePage.js";
import { FontsPage } from "./FontsPage.js";
import { FormatPage } from "./FormatPage.js";
import { HooksPage } from "./HooksPage.js";
import { KeymapPage } from "./KeymapPage.js";
import type { KeyConflictView } from "./KeymapPage.js";
import { SettingsTreePage } from "./SettingsTreePage.js";
import { TemplatesPage } from "./TemplatesPage.js";
import {
  KEYMAP_BASE_STORAGE,
  KEYMAP_CHANGED_EVENT,
  KEYMAP_OVERRIDES_STORAGE,
  commandTitle,
  parseOverrides,
  shellPresetBindings,
} from "./keymap-overrides.js";
import type { KeyBindingView } from "./settings-view.js";

type Page = "appearance" | "fonts" | "keymap" | "format" | "templates" | "hooks" | "all";

const NAV: { id: Page; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "fonts", label: "Fonts" },
  { id: "keymap", label: "Keymap" },
  { id: "format", label: "Formatting" },
  { id: "templates", label: "Live Templates" },
  { id: "hooks", label: "Lifecycle Hooks" },
  { id: "all", label: "All Settings" },
];

/** The well-known EDITOR chords (bound in routes/editor.tsx + EditorPane, not the shell
 *  registry) — surfaced read-only (rebindable:false) so the Keymap page is complete but
 *  never pretends a rebind of a non-registry chord applies (APP-057 / EDITOR_BINDINGS gotcha). */
const EDITOR_BINDINGS: readonly KeyBindingView[] = [
  {
    command: "Command Palette (commands)",
    keys: "mod+shift+p",
    source: "preset",
    rebindable: false,
  },
  { command: "Quick Open (files)", keys: "mod+p", source: "preset", rebindable: false },
  { command: "Open File", keys: "mod+o", source: "preset", rebindable: false },
  { command: "Save File", keys: "mod+s", source: "preset", rebindable: false },
  { command: "AI: Inline Edit", keys: "mod+i", source: "preset", rebindable: false },
];

/** The base-preset selector options: the live Prometheus default + the 3 core presets
 *  (shown as read-only reference rows for JetBrains/VS Code/Vim parity, APP-057). */
const KEYMAP_PRESETS: readonly { id: string; label: string }[] = [
  { id: "default", label: "Prometheus Default" },
  ...BUILTIN_KEYMAPS.map((k) => ({ id: k.id, label: k.label })),
];

/** id → title for a CORE-preset command (its own catalog), falling back to the id. */
function presetCommandTitle(id: string): string {
  return BINDABLE_COMMANDS.find((c) => c.id === id)?.title ?? id;
}

/** Persist the override layer + fire the same-tab change signal the live matcher listens on. */
function persistOverrides(overrides: readonly KeyBinding[]): void {
  window.localStorage.setItem(KEYMAP_OVERRIDES_STORAGE, JSON.stringify(overrides));
  window.dispatchEvent(new CustomEvent(KEYMAP_CHANGED_EVENT));
}

export interface SettingsPanelProps {
  /** the active project root, if any — threaded to the "All Settings" tree so it can
   *  read/write the workspace layer; the other pages don't need it. */
  workspaceRoot?: string;
}

export function SettingsPanel({ workspaceRoot }: SettingsPanelProps = {}): ReactElement {
  const [page, setPage] = useState<Page>("appearance");
  // APP-057: the user rebind layer + selected base preset, persisted (localStorage, no
  // secrets). The base preset is a declared preference + the read-only reference block; the
  // LIVE default layer is always the shell registry (shellPresetBindings) so a rebind is
  // never faked onto a non-live command.
  const [baseId, setBaseId] = useState<string>(
    () => window.localStorage.getItem(KEYMAP_BASE_STORAGE) || "default",
  );
  const [overrides, setOverrides] = useState<KeyBinding[]>(() =>
    parseOverrides(window.localStorage.getItem(KEYMAP_OVERRIDES_STORAGE)),
  );

  const preset = useMemo(() => shellPresetBindings(), []);
  const merged = useMemo(() => mergeUserBindings(preset, overrides), [preset, overrides]);
  const conflicts = useMemo(() => detectConflicts(merged), [merged]);

  // the table: live/rebindable shell rows (user overrides merged) + the selected preset's
  // reference rows (read-only) + the read-only editor-route chords.
  const keymapRows = useMemo<KeyBindingView[]>(() => {
    const shellRows: KeyBindingView[] = merged.map((b) => ({
      command: commandTitle(b.command),
      id: b.command,
      keys: b.keys,
      source: b.source,
      rebindable: true,
      ...(b.when ? { when: b.when } : {}),
    }));
    const km = baseId === "default" ? undefined : getKeymap(baseId);
    const refRows: KeyBindingView[] = km
      ? resolveBindings(km).map((b) => ({
          command: presetCommandTitle(b.command),
          keys: b.keys,
          source: "preset" as const,
          rebindable: false,
          ...(b.when ? { when: b.when } : {}),
        }))
      : [];
    return [...shellRows, ...refRows, ...EDITOR_BINDINGS];
  }, [merged, baseId]);

  const conflictViews = useMemo<KeyConflictView[]>(
    () =>
      conflicts.map((c) => ({
        keys: c.keys,
        ...(c.when ? { when: c.when } : {}),
        commands: c.commands.map(commandTitle),
      })),
    [conflicts],
  );

  const onRebind = (id: string, keys: string): void => {
    const next = applyUserBinding(preset, overrides, { command: id, keys, source: "user" });
    setOverrides(next);
    persistOverrides(next);
  };
  const onReset = (id: string): void => {
    const next = clearUserBinding(overrides, id);
    setOverrides(next);
    persistOverrides(next);
  };
  const checkConflicts = (id: string, keys: string): KeyConflictView[] =>
    conflictsForCandidate(merged, { command: id, keys }).map((c) => ({
      keys: c.keys,
      ...(c.when ? { when: c.when } : {}),
      commands: c.commands.map(commandTitle),
    }));
  const onSelectBase = (id: string): void => {
    setBaseId(id);
    window.localStorage.setItem(KEYMAP_BASE_STORAGE, id);
  };

  // APP-093: the CURRENT keymap = the selected base + the user override layer, exported as a
  // shareable Keymap. Round-trips through core exportKeymap/importKeymap.
  const [importStatus, setImportStatus] = useState<{
    kind: "error" | "ok";
    message: string;
  } | null>(null);
  const currentKeymap = (): Keymap => ({
    id: "prometheus-user-keymap",
    ...(baseId !== "default" ? { base: baseId } : {}),
    label: "Prometheus (exported)",
    builtin: false,
    bindings: overrides,
  });
  const onExport = (): void => {
    void (async () => {
      const api = window.prometheus?.ide;
      if (!api || !workspaceRoot) {
        setImportStatus({ kind: "error", message: "open a folder to export the keymap" });
        return;
      }
      const json = exportKeymap(currentKeymap());
      const uri = `file://${workspaceRoot}/prometheus-keymap.json`;
      const r = await api.fsWrite(uri, json).catch(() => undefined);
      setImportStatus(
        r?.ok
          ? { kind: "ok", message: "exported to prometheus-keymap.json" }
          : { kind: "error", message: r?.error ?? "export failed" },
      );
    })();
  };
  const onImport = (): void => {
    void (async () => {
      const picked = await window.prometheus
        ?.fileOpen?.({ title: "Import keymap JSON" })
        .catch(() => undefined);
      if (!picked?.ok || !picked.path) return; // cancelled
      const read = await window.prometheus?.ide
        ?.fsRead(`file://${picked.path}`)
        .catch(() => undefined);
      if (!read?.ok || typeof read.text !== "string") {
        setImportStatus({ kind: "error", message: read?.error ?? "could not read the file" });
        return;
      }
      const result = importKeymap(read.text);
      if ("error" in result) {
        // fail-closed: the active keymap is UNTOUCHED on a malformed/foreign file.
        setImportStatus({ kind: "error", message: `invalid keymap: ${result.error}` });
        return;
      }
      // apply: rebase + replace the override layer, persisting both (conflicts re-derive).
      const nextBase = result.base ?? "default";
      setBaseId(nextBase);
      window.localStorage.setItem(KEYMAP_BASE_STORAGE, nextBase);
      setOverrides(result.bindings);
      persistOverrides(result.bindings);
      setImportStatus({ kind: "ok", message: `imported ${result.bindings.length} binding(s)` });
    })();
  };

  return (
    <div style={{ display: "flex", gap: "var(--space-6, 12px)", minHeight: 0 }}>
      <nav
        aria-label="settings categories"
        style={{ display: "flex", flexDirection: "column", gap: 2, width: 140, flexShrink: 0 }}
      >
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            aria-current={page === n.id}
            onClick={() => setPage(n.id)}
            style={navBtn(page === n.id)}
          >
            {n.label}
          </button>
        ))}
        {/* APP-064: explicit re-entry to the first-run wizard (flag already set → only via this). */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("prometheus:run-onboarding"))}
          style={{ ...navBtn(false), marginTop: "var(--space-4, 8px)", color: "var(--accent)" }}
        >
          Run setup wizard…
        </button>
      </nav>
      <div style={{ flex: 1, minWidth: 0 }}>
        {page === "appearance" && <AppearancePage {...(workspaceRoot ? { workspaceRoot } : {})} />}
        {page === "fonts" && <FontsPage />}
        {page === "format" && <FormatPage />}
        {page === "templates" && <TemplatesPage />}
        {page === "hooks" && <HooksPage {...(workspaceRoot ? { workspaceRoot } : {})} />}
        {page === "keymap" && (
          <KeymapPage
            presets={KEYMAP_PRESETS}
            baseId={baseId}
            bindings={keymapRows}
            conflicts={conflictViews}
            onSelectBase={onSelectBase}
            onRebind={onRebind}
            onReset={onReset}
            checkConflicts={checkConflicts}
            onExport={onExport}
            onImport={onImport}
            importStatus={importStatus}
          />
        )}
        {page === "all" && <SettingsTreePage workspaceRoot={workspaceRoot} />}
      </div>
    </div>
  );
}

function navBtn(active: boolean): CSSProperties {
  return {
    textAlign: "left",
    padding: "var(--space-2, 4px) var(--space-3, 6px)",
    background: active ? "var(--bg-inset)" : "transparent",
    border: "none",
    borderRadius: "var(--radius-sm, 4px)",
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    cursor: "pointer",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-small-size, 0.8125rem)",
  };
}

export default SettingsPanel;
