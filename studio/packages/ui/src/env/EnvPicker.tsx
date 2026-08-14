/**
 * EnvPicker.tsx — the Environments left rail + detail header (file 04 §3.1).
 *
 * A left list of detected envs (venv / conda / engine / system) with kind + scope
 * + health chips, and a detail header for the selected env carrying the
 * health/cuda/managed-by chips and the action row (Use / Clone / Reveal / Export
 * / Delete). PURELY presentational: it takes the env list + selection + action
 * callbacks as PROPS — it performs NO IPC, holds NO engine handle, and renders
 * every engine string as inert text (C5). Engine-managed envs are surfaced
 * read-mostly (destructive actions disabled; the host routes those to the Model
 * Hub). Imports only react + this package.
 */

import type { ReactElement, ReactNode } from "react";
import type { EnvRowData } from "./types.js";
import {
  allowsDestructive,
  formatBytes,
  healthGlyph,
  healthRole,
  inert,
  managedByLabel,
  roleVar,
} from "./util.js";

export interface EnvPickerProps {
  /** the detected envs (engine-bridge Env rows pass straight in). */
  envs: EnvRowData[];
  /** the selected env id, or null. */
  selectedId: string | null;
  onSelect(id: string): void;
  /** mark the selected env active (editor/terminal pick it up). */
  onUse?(id: string): void;
  /** clone the selected env (freeze → gated reinstall). */
  onClone?(id: string): void;
  /** reveal the env folder in the OS file manager. */
  onReveal?(id: string): void;
  /** export the env's requirements/conda yaml. */
  onExport?(id: string): void;
  /** delete the selected env (typed confirm collected by the host). */
  onDelete?(id: string): void;
  /** open the create-env wizard. */
  onCreate?(): void;
  /**
   * handoff_3 §5: extra cells rendered INSIDE each row — the detail line ("python 3.12 · 84
   * packages") and the coloured status text.
   *
   * Injected rather than computed here on purpose. The rules for "what counts as broken" and
   * "which action does this row offer" are pinned by node:test in the app
   * (routes/workspace-view.ts); a second implementation inside this component would be a
   * second answer to the same question, free to drift from the tested one.
   */
  renderRowExtra?(env: EnvRowData): ReactNode;
  /** handoff_3 §5: the per-row action (Activate / Inspect / Recreate). */
  rowAction?: {
    label(env: EnvRowData): string;
    onAct(id: string): void;
  };
  className?: string;
}

/** A small inline pill. */
function Chip({
  children,
  roleHint,
  title,
}: {
  children: string;
  roleHint?: ReturnType<typeof healthRole>;
  title?: string;
}): ReactElement {
  return (
    <span
      title={title}
      style={{
        paddingInline: "var(--space-3, 6px)",
        paddingBlock: "var(--space-1, 2px)",
        borderRadius: "var(--radius-full, 9999px)",
        border: "1px solid var(--border-subtle)",
        color: roleHint ? roleVar(roleHint) : "var(--text-secondary)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function kindGlyph(kind: string): string {
  if (kind === "conda") return "◇";
  if (kind === "engine") return "⚙";
  if (kind === "system") return "▤";
  return "▢";
}

export function EnvPicker({
  envs,
  selectedId,
  onSelect,
  onUse,
  onClone,
  onReveal,
  onExport,
  onDelete,
  onCreate,
  renderRowExtra,
  rowAction,
  className,
}: EnvPickerProps): ReactElement {
  const selected = envs.find((e) => e.id === selectedId) ?? null;

  return (
    <div
      className={className}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(220px, 280px) minmax(0, 1fr)",
        gap: "var(--space-6, 12px)",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      {/* ── left rail ─────────────────────────────────────────────────────── */}
      <nav aria-label="Environments" style={{ display: "flex", flexDirection: "column" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingBlock: "var(--space-3, 6px)",
          }}
        >
          <strong
            style={{ fontSize: "var(--text-small-size, 0.8125rem)", letterSpacing: "0.04em" }}
          >
            ENVIRONMENTS
          </strong>
          <button
            type="button"
            onClick={onCreate}
            aria-label="New environment"
            disabled={!onCreate}
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md, 6px)",
              color: "var(--text-primary)",
              cursor: onCreate ? "pointer" : "default",
              paddingInline: "var(--space-3, 6px)",
            }}
          >
            +
          </button>
        </header>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "2px" }}>
          {envs.map((e) => {
            const isSel = e.id === selectedId;
            return (
              <li key={e.id} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                <button
                  type="button"
                  onClick={() => onSelect(e.id)}
                  aria-current={isSel ? "true" : undefined}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-3, 6px)",
                    padding: "var(--space-3, 6px) var(--space-4, 8px)",
                    borderRadius: "var(--radius-md, 6px)",
                    border: "1px solid",
                    borderColor: isSel ? "var(--border-strong)" : "transparent",
                    background: isSel ? "var(--bg-surface-2)" : "transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    fontFamily: "var(--font-ui)",
                  }}
                >
                  <span aria-hidden="true" style={{ color: roleVar(healthRole(e.health)) }}>
                    {e.active ? "●" : "○"}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {inert(e.name)}
                  </span>
                  {renderRowExtra ? (
                    renderRowExtra(e)
                  ) : (
                    <span
                      aria-hidden="true"
                      style={{ color: "var(--text-secondary)", fontSize: "0.78rem" }}
                    >
                      {kindGlyph(e.kind)} {inert(e.kind)}
                    </span>
                  )}
                </button>
                {rowAction && (
                  // OUTSIDE the select button: a button inside a button is invalid HTML that
                  // browsers silently un-nest, dropping the inner handler.
                  <button
                    type="button"
                    onClick={() => rowAction.onAct(e.id)}
                    style={{
                      flex: "none",
                      marginInlineStart: "var(--space-3, 6px)",
                      background: "var(--bg-inset)",
                      border: "1px solid var(--border-chip)",
                      borderRadius: "var(--radius-md, 6px)",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                      fontFamily: "var(--font-ui)",
                      fontSize: "0.72rem",
                      fontWeight: 600,
                      paddingBlock: "var(--space-1, 2px)",
                      paddingInline: "var(--space-3, 6px)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {rowAction.label(e)}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ── detail header ─────────────────────────────────────────────────── */}
      <section aria-label="Environment detail">
        {selected === null ? (
          <p style={{ color: "var(--text-secondary)", marginTop: 0 }}>
            Select an environment from the left.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
            <header style={{ display: "flex", alignItems: "baseline", gap: "var(--space-4, 8px)" }}>
              <h2 style={{ margin: 0, fontSize: "var(--text-h1-size, 1.375rem)" }}>
                {inert(selected.name)}
              </h2>
              <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                kind {inert(selected.kind)} · scope {inert(selected.scope)}
              </span>
              {selected.active && <Chip roleHint="ok">● ACTIVE</Chip>}
            </header>

            <code
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.8rem",
                color: "var(--text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {inert(selected.path)}
            </code>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-4, 8px)",
                flexWrap: "wrap",
                fontSize: "0.85rem",
              }}
            >
              <span>python {inert(selected.pythonVersion) || "—"}</span>
              <span style={{ color: "var(--text-secondary)" }}>·</span>
              <span>{selected.packageCount} pkgs</span>
              <span style={{ color: "var(--text-secondary)" }}>·</span>
              <span>{formatBytes(selected.sizeBytes)}</span>
              <span style={{ color: "var(--text-secondary)" }}>·</span>
              <span>torch sees CUDA: {selected.cuda?.available ? "✓" : "✗ (CPU)"}</span>
            </div>

            <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
              <Chip
                roleHint={healthRole(selected.health)}
                title="pyvenv.cfg parses? interpreter runs?"
              >
                {`health ${healthGlyph(selected.health)} ${inert(selected.health)}`}
              </Chip>
              <Chip title="who created this env (governs destructive ops)">
                {`managed-by ${managedByLabel(selected.managedBy)}`}
              </Chip>
              {selected.createdAt && <Chip>{`created ${inert(selected.createdAt)}`}</Chip>}
            </div>

            {/* ── action row (Use / Clone / Reveal / Export / Delete) ──────── */}
            <div
              style={{
                display: "flex",
                gap: "var(--space-3, 6px)",
                flexWrap: "wrap",
                padding: "var(--space-3, 6px)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md, 6px)",
              }}
            >
              <ActionButton label="Use" onClick={onUse ? () => onUse(selected.id) : undefined} />
              <ActionButton
                label="Clone…"
                onClick={onClone ? () => onClone(selected.id) : undefined}
              />
              <ActionButton
                label="Reveal"
                onClick={onReveal ? () => onReveal(selected.id) : undefined}
              />
              <ActionButton
                label="Export reqs"
                onClick={onExport ? () => onExport(selected.id) : undefined}
              />
              <ActionButton
                label="Delete"
                danger
                // engine-managed / external envs are read-mostly: destructive op disabled.
                disabled={!allowsDestructive(selected.managedBy) || !onDelete}
                onClick={onDelete ? () => onDelete(selected.id) : undefined}
                title={
                  allowsDestructive(selected.managedBy)
                    ? undefined
                    : "Engine/external env — delete via the Model Hub to keep its bookkeeping intact."
                }
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  danger,
  disabled,
  title,
}: {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      title={title}
      style={{
        background: "transparent",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md, 6px)",
        color: danger ? "var(--danger)" : "var(--text-primary)",
        cursor: disabled || !onClick ? "default" : "pointer",
        opacity: disabled || !onClick ? 0.45 : 1,
        padding: "var(--space-2, 4px) var(--space-4, 8px)",
        fontSize: "0.85rem",
        fontFamily: "var(--font-ui)",
      }}
    >
      {label}
    </button>
  );
}

export default EnvPicker;
