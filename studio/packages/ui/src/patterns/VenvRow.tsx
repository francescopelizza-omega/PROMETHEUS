/**
 * VenvRow.tsx + PackageRow.tsx — the §5.3 environment rows (08 §3.2).
 *
 * VenvRow: name · python ver · pkg count · size · active-dot (the §5.3 sidebar /
 * list row). PackageRow: name · version · a component-state pill · a `<VerdictBadge>`
 * from the pre-install gate · size (the §5.3 package table row).
 *
 * Bind `VenvRowData` / `PackageRowData` (mirrors of the venv list + pip/conda state)
 * via TYPE-ONLY imports (C5). The renderer passes a real env row straight in.
 *
 * GOLDEN RULE (C5): NEVER decides "safe" — a package row's verdict is the engine's
 * pre-install gate result, rendered inert. State pills reuse the §2.2 component-
 * state tokens (color + glyph, never color alone). Actions are callback PROPS.
 */

import type { ReactElement } from "react";
import { VerdictBadge } from "../components/VerdictBadge.js";
import { DOT } from "../tokens.js";
import type { PackageRowData, VenvRowData } from "./types.js";
import { type StatePill, formatBytes, inert, stateGlyph, stateVar } from "./util.js";

/* ── VenvRow ──────────────────────────────────────────────────────────────── */

export interface VenvRowProps {
  venv: VenvRowData;
  /** Activate this environment (the §5.3 [ Activate ] action). */
  onActivate?: () => void;
  /** Open the environment detail / overflow menu. */
  onOpen?: () => void;
  className?: string;
}

export function VenvRow({ venv, onActivate, onOpen, className }: VenvRowProps): ReactElement {
  const name = inert(venv.name) || "venv";
  const py = inert(venv.pythonVersion);
  const dotGlyph = venv.active ? DOT.present : DOT.absent;
  const dotColor = venv.active ? "var(--ok)" : "var(--text-secondary)";

  return (
    <div
      className={className}
      data-active={venv.active ? "true" : "false"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4, 8px)",
        paddingBlock: "var(--space-3, 6px)",
        paddingInline: "var(--space-4, 8px)",
        borderBottom: "1px solid var(--border-subtle)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <span
        aria-label={venv.active ? "active" : "inactive"}
        style={{ color: dotColor, fontFamily: "var(--font-mono)", lineHeight: 1 }}
      >
        {dotGlyph}
      </span>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            textAlign: "left",
          }}
        >
          {name}
        </button>
      ) : (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{name}</span>
      )}
      {py.length > 0 && (
        <span
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {py}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {typeof venv.packageCount === "number" && (
        <span
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          {venv.packageCount} pkg
        </span>
      )}
      <span
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          minWidth: "3.5em",
          textAlign: "right",
        }}
      >
        {formatBytes(venv.sizeBytes)}
      </span>
      {!venv.active && onActivate && (
        <button type="button" onClick={onActivate} style={rowBtn()}>
          Activate
        </button>
      )}
    </div>
  );
}

/* ── PackageRow ───────────────────────────────────────────────────────────── */

/** Map a package state → the StatePill key the §2.2 tokens project. */
function packageStatePill(state: PackageRowData["state"]): StatePill {
  switch (state) {
    case "installed":
      return "installed";
    case "pending":
      return "pending";
    case "missing":
      return "missing";
    default:
      return "disabled";
  }
}

export interface PackageRowProps {
  pkg: PackageRowData;
  /** Install / review the package (the §5.3 gate-gated action). */
  onAction?: () => void;
  /** Open the package overflow menu. */
  onMenu?: () => void;
  className?: string;
}

export function PackageRow({ pkg, onAction, onMenu, className }: PackageRowProps): ReactElement {
  const name = inert(pkg.name) || "package";
  const version = inert(pkg.version ?? "");
  const pill = packageStatePill(pkg.state);
  const pillColor = stateVar(pill);
  const actionLabel =
    pkg.state === "missing" ? "install" : pkg.state === "pending" ? "review→" : "use";

  return (
    <div
      className={className}
      data-state={pkg.state}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4, 8px)",
        paddingBlock: "var(--space-3, 6px)",
        paddingInline: "var(--space-4, 8px)",
        borderBottom: "1px solid var(--border-subtle)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, minWidth: "8em" }}>
        {name}
      </span>
      <span
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          minWidth: "5em",
        }}
      >
        {version.length > 0 ? version : "—"}
      </span>
      {/* state pill — color + glyph + text (never color alone, 08 §7). */}
      <span
        data-pill={pill}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-2, 4px)",
          color: pillColor,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          minWidth: "6em",
        }}
      >
        <span aria-hidden="true">{stateGlyph(pill)}</span>
        {pkg.state}
      </span>
      {pkg.verdict != null && <VerdictBadge verdict={pkg.verdict} compact />}
      <span style={{ flex: 1 }} />
      <span
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          minWidth: "3.5em",
          textAlign: "right",
        }}
      >
        {formatBytes(pkg.sizeBytes)}
      </span>
      {onAction && (
        <button type="button" onClick={onAction} style={rowBtn()}>
          {actionLabel}
        </button>
      )}
      {onMenu && (
        <button
          type="button"
          aria-label="Package menu"
          onClick={onMenu}
          style={{ ...rowBtn(), paddingInline: "var(--space-3, 6px)" }}
        >
          ⋯
        </button>
      )}
    </div>
  );
}

function rowBtn() {
  return {
    paddingInline: "var(--space-4, 8px)",
    paddingBlock: "var(--space-1, 2px)",
    borderRadius: "var(--radius-sm, 4px)",
    cursor: "pointer",
    background: "transparent",
    border: "1px solid var(--border-strong)",
    color: "var(--text-secondary)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-small-size, 0.8125rem)",
  } as const;
}

export default VenvRow;
