// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * SettingsTreePage.tsx — mounts SettingsTree against the REAL `settings:*` IPC
 * (APP-017): the core-served keyed/layered tree, previously a finished-but-orphaned
 * component with zero mounts. Left = SettingsTree (search + provenance badges);
 * right = the selected node's effective value + a scoped editor + reset-to-default.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + window.prometheus.settings only.
 */
import { Panel } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useCallback, useEffect, useState } from "react";

import { SettingsTree } from "./SettingsTree.js";
import {
  SETTINGS_SCOPES,
  displayValue,
  provenanceSummary,
  rawAtScope,
  scopeToWriteScope,
} from "./settings-scope.js";
import { type SettingsNodeView, type SettingsUiScope, isEditableControl } from "./settings-view.js";

export interface SettingsTreePageProps {
  /** the active project root, if any — required to read/write the workspace layer;
   *  global-scope settings work fine with no folder open. */
  workspaceRoot?: string;
}

function findById(nodes: readonly SettingsNodeView[], id: string): SettingsNodeView | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = n.children ? findById(n.children, id) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

function coerceForControl(control: string | undefined, raw: string): unknown {
  if (control === "toggle") return raw === "true";
  if (control === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

export function SettingsTreePage({ workspaceRoot }: SettingsTreePageProps): ReactElement {
  const [nodes, setNodes] = useState<SettingsNodeView[] | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  // APP-058: the selected editable scope tab (default read-only ← user ← project).
  const [scope, setScope] = useState<SettingsUiScope>("user");

  const reload = useCallback(async () => {
    const res = await window.prometheus?.settings?.list(workspaceRoot);
    if (!res?.ok) {
      setError(res?.error ?? "settings IPC unavailable");
      return;
    }
    setError(undefined);
    setNodes(res.nodes ?? []);
  }, [workspaceRoot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = nodes && selectedId ? findById(nodes, selectedId) : undefined;

  const onSet = useCallback(
    async (value: unknown, scope: "global" | "workspace") => {
      if (!selected?.schemaKey) return;
      setPending(true);
      try {
        const res = await window.prometheus?.settings?.set(
          selected.schemaKey,
          value,
          scope,
          workspaceRoot,
        );
        if (res && !res.ok) setError(res.error ?? "set failed");
        else await reload();
      } finally {
        setPending(false);
      }
    },
    [selected, workspaceRoot, reload],
  );

  const onReset = useCallback(
    async (scope: "global" | "workspace") => {
      if (!selected?.schemaKey) return;
      setPending(true);
      try {
        const res = await window.prometheus?.settings?.reset(
          selected.schemaKey,
          scope,
          workspaceRoot,
        );
        if (res && !res.ok) setError(res.error ?? "reset failed");
        else await reload();
      } finally {
        setPending(false);
      }
    },
    [selected, workspaceRoot, reload],
  );

  if (error) {
    return (
      <Panel title="All Settings" elevation="e1">
        <div style={{ color: "var(--danger)", padding: "var(--space-4, 8px)" }}>{error}</div>
      </Panel>
    );
  }
  if (!nodes) {
    return (
      <Panel title="All Settings" elevation="e1">
        <div style={{ color: "var(--text-secondary)", padding: "var(--space-4, 8px)" }}>
          loading…
        </div>
      </Panel>
    );
  }

  return (
    <div style={{ display: "flex", gap: "var(--space-6, 12px)", minHeight: 0 }}>
      <div style={{ width: 260, flexShrink: 0 }}>
        <SettingsTree nodes={nodes} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Panel title={selected?.title ?? "Select a setting"} elevation="e1">
          {!selected && (
            <div style={{ color: "var(--text-secondary)" }}>
              Pick a node on the left to see its effective value, provenance, and edit it.
            </div>
          )}
          {selected && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
              {/* effective value + provenance chain (APP-058). */}
              <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                {selected.category} · owner [{selected.ownerFile}]
                {selected.schemaKey && (
                  <>
                    {" · effective: "}
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>
                      {displayValue(selected.value)}
                    </span>
                    {" · "}
                    {provenanceSummary(selected)}
                  </>
                )}
              </div>
              {!selected.schemaKey && (
                <div style={{ color: "var(--text-secondary)" }}>
                  This is a category — pick a leaf node to edit a value.
                </div>
              )}
              {selected.schemaKey && (
                // scope tabs: each shows the RAW value at that scope (or "not set").
                <div role="tablist" aria-label="settings scope" style={{ display: "flex", gap: 2 }}>
                  {SETTINGS_SCOPES.map((tab) => {
                    const raw = rawAtScope(selected, tab.id);
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={scope === tab.id}
                        onClick={() => setScope(tab.id)}
                        style={scopeTabStyle(scope === tab.id)}
                      >
                        {tab.label}
                        <span
                          style={{
                            marginLeft: "var(--space-2, 4px)",
                            color: raw.set ? "var(--accent)" : "var(--text-secondary)",
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.7rem",
                          }}
                        >
                          {raw.set ? displayValue(raw.value) : "not set"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {selected.schemaKey && !isEditableControl(selected.control, selected.value) && (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 4px)" }}
                >
                  <div style={{ color: "var(--text-secondary)" }}>
                    Structured value — edit via its dedicated page (e.g. Keymap) rather than here.
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.75rem",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {JSON.stringify(selected.value, null, 2)}
                  </pre>
                </div>
              )}
              {selected.schemaKey &&
                isEditableControl(selected.control, selected.value) &&
                (scope === "default" ? (
                  <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                    Default is the shipped value — read-only. Switch to User or Project to edit.
                  </div>
                ) : (
                  <EditableValue
                    control={selected.control}
                    {...(selected.options ? { options: selected.options } : {})}
                    // seed the editor from the scope's own value if set, else the effective.
                    value={
                      rawAtScope(selected, scope).set
                        ? rawAtScope(selected, scope).value
                        : selected.value
                    }
                    pending={pending}
                    writeScope={scopeToWriteScope(scope) ?? "global"}
                    canRemove={rawAtScope(selected, scope).set}
                    disabled={scope === "project" && !workspaceRoot}
                    disabledNote={
                      scope === "project" && !workspaceRoot
                        ? "Open a project folder to edit Project-scope settings."
                        : undefined
                    }
                    onSet={onSet}
                    onReset={onReset}
                  />
                ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function scopeTabStyle(active: boolean): CSSProperties {
  return {
    padding: "var(--space-1, 2px) var(--space-3, 6px)",
    background: active ? "var(--bg-inset)" : "transparent",
    border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
    borderRadius: "var(--radius-sm, 4px)",
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    cursor: "pointer",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-small-size, 0.8125rem)",
  };
}

/** The value editor for ONE scope (APP-058): writes to `writeScope`; "Remove override"
 *  deletes the key at that scope (enabled only when this scope actually sets it). */
function EditableValue({
  control,
  options,
  value,
  pending,
  writeScope,
  canRemove,
  disabled,
  disabledNote,
  onSet,
  onReset,
}: {
  control: string | undefined;
  /** the closed set of valid values for a `select`; absent ⇒ free text (see tree.ts). */
  options?: readonly { value: string; label: string }[];
  value: unknown;
  pending: boolean;
  writeScope: "global" | "workspace";
  canRemove: boolean;
  disabled: boolean;
  disabledNote?: string;
  onSet: (value: unknown, scope: "global" | "workspace") => void;
  onReset: (scope: "global" | "workspace") => void;
}): ReactElement {
  const [draft, setDraft] = useState(() => String(value ?? ""));
  useEffect(() => setDraft(String(value ?? "")), [value]);
  const locked = pending || disabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
      {control === "toggle" ? (
        <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2, 4px)" }}>
          <input
            type="checkbox"
            checked={value === true}
            disabled={locked}
            onChange={(e) => onSet(e.currentTarget.checked, writeScope)}
          />
          {value === true ? "on" : "off"}
        </label>
      ) : control === "select" && options && options.length > 0 ? (
        // A CLOSED SET is offered as a closed set. Before this branch existed, `control:
        // "select"` fell through to the text input below, so a "choice" setting was free text
        // that nothing validated — the tree declared an intent the UI never honoured.
        <select
          value={String(value ?? "")}
          disabled={locked}
          onChange={(e) => onSet(e.currentTarget.value, writeScope)}
          style={{
            background: "var(--bg-inset)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm, 4px)",
            padding: "var(--space-2, 4px)",
            fontFamily: "var(--font-ui)",
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={draft}
          disabled={locked}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => onSet(coerceForControl(control, draft), writeScope)}
          type={control === "number" ? "number" : control === "color" ? "color" : "text"}
          style={{
            background: "var(--bg-inset)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm, 4px)",
            padding: "var(--space-2, 4px)",
            fontFamily: "var(--font-ui)",
          }}
        />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3, 6px)" }}>
        <button
          type="button"
          disabled={locked || !canRemove}
          onClick={() => onReset(writeScope)}
          title={
            canRemove ? "Delete this scope's override" : "This scope has no override to remove"
          }
        >
          Remove override
        </button>
        {disabledNote && (
          <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>{disabledNote}</span>
        )}
      </div>
    </div>
  );
}

export default SettingsTreePage;
