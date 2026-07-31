/**
 * KeymapPage.tsx — the §2.2 Keymap editor UI (file 13).
 *
 * Presentational + controlled: the keymap presets, the resolved bindings, and the
 * detected conflicts are computed in @prometheus/core and passed in (the renderer can't
 * import core — C5). Renders the action/shortcut/when/source table with glyph-rendered
 * keys, a base-preset selector, and an inline conflict warning offering
 * Remove-other / Keep-both. No raw hex.
 */
import { Button, Panel } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useMemo, useState } from "react";

import { ChordRecorder } from "./ChordRecorder.js";
import { type KeyBindingView, formatKeys, normalizeForDisplay } from "./settings-view.js";

/** A detected conflict (mirrors core KeyConflict). */
export interface KeyConflictView {
  keys: string; // normalized
  when?: string;
  commands: string[];
}

export interface KeymapPageProps {
  presets: readonly { id: string; label: string }[];
  baseId: string;
  bindings: readonly KeyBindingView[];
  conflicts: readonly KeyConflictView[];
  onSelectBase: (id: string) => void;
  onResolveConflict?: (
    conflict: KeyConflictView,
    choice: "remove-other" | "keep-both",
    keep?: string,
  ) => void;
  /** APP-057: commit a rebind (command id → new keys string) — override wins live. */
  onRebind?: (id: string, keys: string) => void;
  /** APP-057: reset a user-overridden command back to its preset default. */
  onReset?: (id: string) => void;
  /** APP-057: the conflicts a candidate chord WOULD introduce (pre-save check, from core). */
  checkConflicts?: (id: string, keys: string) => KeyConflictView[];
  /** APP-093: export the current keymap to a shareable JSON file (SettingsPanel owns the IPC). */
  onExport?: () => void;
  /** APP-093: import a keymap JSON file (pick → validate → apply; errors surface via `importStatus`). */
  onImport?: () => void;
  /** APP-093: the outcome of the last export/import — an inline error (validation) or a success note. */
  importStatus?: { kind: "error" | "ok"; message: string } | null;
}

/** A pending rebind awaiting the user's proceed/cancel on its pre-save conflicts. */
interface PendingRebind {
  id: string;
  keys: string;
  conflicts: KeyConflictView[];
}

/** The §2.2 keymap page. */
export function KeymapPage({
  presets,
  baseId,
  bindings,
  conflicts,
  onSelectBase,
  onResolveConflict,
  onRebind,
  onReset,
  checkConflicts,
  onExport,
  onImport,
  importStatus,
}: KeymapPageProps): ReactElement {
  const [filter, setFilter] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRebind | null>(null);
  const conflictKeys = useMemo(() => new Set(conflicts.map((c) => c.keys)), [conflicts]);

  // A recorder committed a chord: check for conflicts BEFORE applying. Clean → apply now;
  // conflicting → stash a pending rebind so the user must confirm (proceed) or cancel.
  const onChordCommit = (id: string, keys: string): void => {
    setRecordingId(null);
    const found = checkConflicts?.(id, keys) ?? [];
    if (found.length === 0) {
      onRebind?.(id, keys);
    } else {
      setPending({ id, keys, conflicts: found });
    }
  };
  const rows = useMemo(
    () =>
      filter
        ? bindings.filter((b) =>
            `${b.command} ${b.keys}`.toLowerCase().includes(filter.toLowerCase()),
          )
        : bindings,
    [bindings, filter],
  );

  const cell: CSSProperties = {
    padding: "var(--space-1, 2px) var(--space-3, 6px)",
    fontSize: "var(--text-small-size, 0.8125rem)",
  };

  return (
    <Panel title="Keymap" elevation="e1">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          marginBottom: "var(--space-3, 6px)",
          flexWrap: "wrap",
        }}
      >
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-2, 4px)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          Base:
          <select
            value={baseId}
            onChange={(e) => onSelectBase(e.currentTarget.value)}
            aria-label="Base keymap"
            style={{
              background: "var(--bg-inset)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-sm, 4px)",
            }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <input
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          placeholder="search actions…"
          aria-label="Search keymap"
          style={{
            flex: 1,
            minWidth: 120,
            background: "var(--bg-inset)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm, 4px)",
            padding: "var(--space-1, 2px) var(--space-2, 4px)",
          }}
        />
        {conflicts.length > 0 && (
          <span style={{ color: "var(--warn)", fontSize: "var(--text-small-size, 0.8125rem)" }}>
            ⚠ {conflicts.length} conflict(s)
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* APP-093: export the current keymap / import a shareable keymap JSON. */}
        {onImport && (
          <Button variant="ghost" onClick={onImport}>
            ⭱ Import
          </Button>
        )}
        {onExport && (
          <Button variant="ghost" onClick={onExport}>
            ⭳ Export
          </Button>
        )}
      </div>

      {importStatus && (
        <div
          role={importStatus.kind === "error" ? "alert" : undefined}
          style={{
            marginBottom: "var(--space-2, 4px)",
            padding: "var(--space-1, 2px) var(--space-3, 6px)",
            borderRadius: "var(--radius-sm, 4px)",
            background: "var(--bg-inset)",
            border: `1px solid var(--${importStatus.kind === "error" ? "danger" : "ok"})`,
            color: `var(--${importStatus.kind === "error" ? "danger" : "ok"})`,
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {importStatus.message}
        </div>
      )}

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: "var(--font-ui)",
          color: "var(--text-primary)",
        }}
      >
        <thead>
          <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
            <th style={cell}>Action</th>
            <th style={cell}>Shortcut</th>
            <th style={cell}>When</th>
            <th style={cell}>Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const conflicted = conflictKeys.has(normalizeForDisplay(b.keys));
            const canRebind = !!b.rebindable && !!b.id && !!onRebind;
            const recording = recordingId === b.id;
            return (
              <tr
                key={b.id ?? `${b.command}:${b.keys}`}
                style={{ borderTop: "1px solid var(--border-subtle)" }}
              >
                <td style={cell}>{b.command}</td>
                <td style={{ ...cell, fontFamily: "var(--font-mono)" }}>
                  {recording && b.id ? (
                    <ChordRecorder
                      onCommit={(keys) => onChordCommit(b.id as string, keys)}
                      onCancel={() => setRecordingId(null)}
                    />
                  ) : canRebind ? (
                    // click the shortcut to record a new chord (the load-bearing affordance).
                    <button
                      type="button"
                      onClick={() => {
                        setPending(null);
                        setRecordingId(b.id ?? null);
                      }}
                      title="Click to rebind"
                      style={{
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-small-size, 0.8125rem)",
                        padding: 0,
                        color: conflicted ? "var(--warn)" : "var(--text-primary)",
                      }}
                    >
                      {formatKeys(b.keys)} {conflicted ? "⚠" : ""}
                    </button>
                  ) : (
                    <span style={{ color: conflicted ? "var(--warn)" : "var(--text-primary)" }}>
                      {formatKeys(b.keys)} {conflicted ? "⚠" : ""}
                    </span>
                  )}
                </td>
                <td style={{ ...cell, color: "var(--text-secondary)" }}>{b.when ?? "—"}</td>
                <td style={{ ...cell, color: "var(--text-secondary)" }}>
                  {b.source}
                  {b.source === "user" && b.id && onReset && (
                    <button
                      type="button"
                      onClick={() => onReset(b.id as string)}
                      title="Reset to default"
                      style={{
                        marginLeft: "var(--space-2, 4px)",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "var(--accent)",
                        fontSize: "var(--text-small-size, 0.8125rem)",
                        padding: 0,
                      }}
                    >
                      ↺ reset
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* APP-057: pre-save conflict warning — the candidate collides with an existing
          binding on the same scope; the user must proceed (accept the conflict) or cancel. */}
      {pending && (
        <div
          style={{
            marginTop: "var(--space-2, 4px)",
            padding: "var(--space-2, 4px) var(--space-3, 6px)",
            background: "var(--bg-inset)",
            border: "1px solid var(--warn)",
            borderRadius: "var(--radius-sm, 4px)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <span style={{ color: "var(--warn)" }}>⚠ {formatKeys(pending.keys)}</span> already bound
          to: {pending.conflicts.flatMap((c) => c.commands).join(", ")}
          <span
            style={{
              marginLeft: "var(--space-3, 6px)",
              display: "inline-flex",
              gap: "var(--space-2, 4px)",
            }}
          >
            <Button
              variant="secondary"
              onClick={() => {
                onRebind?.(pending.id, pending.keys);
                setPending(null);
              }}
            >
              Bind anyway
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </span>
        </div>
      )}

      {conflicts.map((c) => (
        <div
          key={`${c.keys}:${c.when ?? ""}`}
          style={{
            marginTop: "var(--space-2, 4px)",
            padding: "var(--space-2, 4px) var(--space-3, 6px)",
            background: "var(--bg-inset)",
            border: "1px solid var(--warn)",
            borderRadius: "var(--radius-sm, 4px)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <span style={{ color: "var(--warn)" }}>⚠ {formatKeys(c.keys)}</span> bound to:{" "}
          {c.commands.join(", ")}
          {onResolveConflict && (
            <span
              style={{
                marginLeft: "var(--space-3, 6px)",
                display: "inline-flex",
                gap: "var(--space-2, 4px)",
              }}
            >
              <Button
                variant="secondary"
                onClick={() => onResolveConflict(c, "remove-other", c.commands[0])}
              >
                Remove other
              </Button>
              <Button variant="ghost" onClick={() => onResolveConflict(c, "keep-both")}>
                Keep both
              </Button>
            </span>
          )}
        </div>
      ))}
    </Panel>
  );
}

export default KeymapPage;
