/**
 * PackageTable.tsx — the package list of the selected env (file 04 §3.2 / §9).
 *
 * The table the detail pane shows: name / installed / latest / source / gate
 * badge / requested-by + per-row actions (update · enable · disable · remove ·
 * info). Each row's leading glyph reflects the §9 lifecycle state; transitive
 * deps (`requestedBy === 'dependency'`) are dimmed. PURELY presentational — the
 * row actions are CALLBACK PROPS the host wires to the gated sidecar verbs; this
 * component performs NO IPC and renders every engine string as inert text (C5).
 * The gate column carries the verdict the engine produced — the table never
 * decides "safe". Imports only react + this package.
 */

import type { ReactElement } from "react";
import { GateBadge } from "./GateBadge.js";
import type { PackageRowData } from "./types.js";
import { type RowState, inert, roleVar, rowActions, rowStateGlyph, rowStateRole } from "./util.js";

/** The per-row action verbs the host can wire (each is optional). */
export interface PackageRowCallbacks {
  onUpdate?(name: string): void;
  onEnable?(name: string): void;
  onDisable?(name: string): void;
  onRemove?(name: string): void;
  onInfo?(name: string): void;
  onRescan?(name: string): void;
}

export interface PackageTableProps extends PackageRowCallbacks {
  packages: PackageRowData[];
  /** open the add-package flow. */
  onAdd?(): void;
  /** bulk-update every outdated row (one batched gate plan). */
  onUpdateAll?(): void;
  className?: string;
}

/** Map a row-action verb → its callback (so the action set is data-driven). */
function actionFor(
  verb: string,
  name: string,
  cb: PackageRowCallbacks,
): { label: string; glyph: string; onClick?: () => void; danger?: boolean } | null {
  switch (verb) {
    case "update":
      return {
        label: "Update",
        glyph: "⬆",
        onClick: cb.onUpdate ? () => cb.onUpdate?.(name) : undefined,
      };
    case "enable":
      return {
        label: "Enable",
        glyph: "▶",
        onClick: cb.onEnable ? () => cb.onEnable?.(name) : undefined,
      };
    case "disable":
      return {
        label: "Disable",
        glyph: "⏸",
        onClick: cb.onDisable ? () => cb.onDisable?.(name) : undefined,
      };
    case "remove":
      return {
        label: "Remove",
        glyph: "⌫",
        danger: true,
        onClick: cb.onRemove ? () => cb.onRemove?.(name) : undefined,
      };
    case "rescan":
      return {
        label: "Re-scan",
        glyph: "↻",
        onClick: cb.onRescan ? () => cb.onRescan?.(name) : undefined,
      };
    case "info":
      return {
        label: "Info",
        glyph: "ⓘ",
        onClick: cb.onInfo ? () => cb.onInfo?.(name) : undefined,
      };
    default:
      return null;
  }
}

function countByState(packages: PackageRowData[], state: RowState): number {
  return packages.filter((p) => p.state === state).length;
}

export function PackageTable({
  packages,
  onAdd,
  onUpdateAll,
  className,
  ...callbacks
}: PackageTableProps): ReactElement {
  const okCount = countByState(packages, "installed") + countByState(packages, "enabled");
  const outdated = countByState(packages, "outdated");
  const disabled = countByState(packages, "disabled");
  const blocked = countByState(packages, "blocked");

  return (
    <div
      className={className}
      style={{ fontFamily: "var(--font-ui)", color: "var(--text-primary)" }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          flexWrap: "wrap",
          marginBottom: "var(--space-3, 6px)",
        }}
      >
        <strong>PACKAGES ({packages.length})</strong>
        <span style={{ color: roleVar("ok"), fontSize: "0.85rem" }}>● {okCount} ok</span>
        {outdated > 0 && (
          <span style={{ color: roleVar("accent"), fontSize: "0.85rem" }}>
            ⬆ {outdated} outdated
          </span>
        )}
        {disabled > 0 && (
          <span style={{ color: roleVar("muted"), fontSize: "0.85rem" }}>
            ⏸ {disabled} disabled
          </span>
        )}
        {blocked > 0 && (
          <span style={{ color: roleVar("danger"), fontSize: "0.85rem" }}>
            ⛔ {blocked} blocked
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: "var(--space-3, 6px)" }}>
          <HeaderButton label="+ Add" onClick={onAdd} />
          <HeaderButton label="Update all ⬆" onClick={onUpdateAll} disabled={outdated === 0} />
        </span>
      </header>

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "0.85rem",
        }}
      >
        <thead>
          <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
            <Th>name</Th>
            <Th>installed</Th>
            <Th>latest</Th>
            <Th>source</Th>
            <Th>gate</Th>
            <Th>requested by</Th>
            <Th>actions</Th>
          </tr>
        </thead>
        <tbody>
          {packages.length === 0 ? (
            <tr>
              <td
                colSpan={7}
                style={{ padding: "var(--space-4, 8px)", color: "var(--text-secondary)" }}
              >
                No packages.
              </td>
            </tr>
          ) : (
            packages.map((p) => {
              const transitive = p.requestedBy === "dependency";
              return (
                <tr
                  key={p.name}
                  data-state={p.state}
                  style={{
                    borderTop: "1px solid var(--border-subtle)",
                    opacity: transitive ? 0.62 : 1,
                  }}
                >
                  <td style={{ padding: "var(--space-2, 4px) var(--space-3, 6px)" }}>
                    <span
                      aria-hidden="true"
                      style={{ color: roleVar(rowStateRole(p.state)), marginRight: "6px" }}
                    >
                      {rowStateGlyph(p.state)}
                    </span>
                    {inert(p.name)}
                  </td>
                  <td
                    style={{
                      padding: "var(--space-2, 4px) var(--space-3, 6px)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {inert(p.installed) || "—"}
                  </td>
                  <td
                    style={{
                      padding: "var(--space-2, 4px) var(--space-3, 6px)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {inert(p.latest) || "—"}
                  </td>
                  <td
                    style={{
                      padding: "var(--space-2, 4px) var(--space-3, 6px)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {inert(p.source)}
                  </td>
                  <td style={{ padding: "var(--space-2, 4px) var(--space-3, 6px)" }}>
                    <GateBadge gate={p.gate} />
                  </td>
                  <td
                    style={{
                      padding: "var(--space-2, 4px) var(--space-3, 6px)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {inert(p.requestedBy) || "—"}
                  </td>
                  <td style={{ padding: "var(--space-2, 4px) var(--space-3, 6px)" }}>
                    <span style={{ display: "inline-flex", gap: "var(--space-2, 4px)" }}>
                      {rowActions(p.state).map((verb) => {
                        const a = actionFor(verb, p.name, callbacks);
                        if (!a) return null;
                        return (
                          <button
                            key={verb}
                            type="button"
                            onClick={a.onClick}
                            disabled={!a.onClick}
                            aria-label={`${a.label} ${p.name}`}
                            title={a.label}
                            style={{
                              background: "transparent",
                              border: "none",
                              cursor: a.onClick ? "pointer" : "default",
                              opacity: a.onClick ? 1 : 0.4,
                              color: a.danger ? "var(--danger)" : "var(--text-primary)",
                              fontSize: "0.95rem",
                              padding: 0,
                            }}
                          >
                            {a.glyph}
                          </button>
                        );
                      })}
                    </span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: string }): ReactElement {
  return (
    <th
      style={{
        padding: "var(--space-2, 4px) var(--space-3, 6px)",
        fontWeight: 600,
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {children}
    </th>
  );
}

function HeaderButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      style={{
        background: "transparent",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-md, 6px)",
        color: "var(--text-primary)",
        cursor: disabled || !onClick ? "default" : "pointer",
        opacity: disabled || !onClick ? 0.45 : 1,
        padding: "var(--space-2, 4px) var(--space-3, 6px)",
        fontSize: "0.8rem",
        fontFamily: "var(--font-ui)",
      }}
    >
      {label}
    </button>
  );
}

export default PackageTable;
