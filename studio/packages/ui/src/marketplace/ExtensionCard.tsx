/**
 * marketplace/ExtensionCard.tsx — a .promext row/card (file 09 §5/§6).
 *
 * Shows the extension's name + publisher + verdict chip + the DECLARED permission
 * summary (from the manifest — never re-computed; the UI shows what was declared).
 * Install / Disable are callbacks; the gated install flow runs in the container.
 * Engine/manifest strings are inert().
 */
import type { ReactElement } from "react";
import { inert } from "../patterns/util.js";
import { VerdictChip } from "./VerdictChip.js";
import type { ExtensionRow } from "./types.js";

export interface ExtensionCardProps {
  ext: ExtensionRow;
  onInstall(ext: ExtensionRow): void;
  onToggle?(ext: ExtensionRow, next: boolean): void;
}

export function ExtensionCard({ ext, onInstall, onToggle }: ExtensionCardProps): ReactElement {
  return (
    <article
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3, 6px)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-lg, 10px)",
        padding: "var(--space-6, 12px)",
        background: "var(--bg-surface)",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: "var(--space-4, 8px)" }}>
        <strong
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {inert(ext.name)}
          {ext.publisher && (
            <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
              {" "}
              · {inert(ext.publisher)}
            </span>
          )}
        </strong>
        <VerdictChip verdict={ext.worstVerdict} />
      </header>

      {ext.summary && (
        <p
          style={{
            margin: 0,
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {inert(ext.summary)}
        </p>
      )}

      <div>
        <span
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          Permissions:
        </span>
        <ul
          style={{
            margin: "var(--space-2, 4px) 0 0",
            paddingInlineStart: "var(--space-12, 24px)",
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {ext.permissions.map((p) => (
            <li key={p}>{inert(p)}</li>
          ))}
        </ul>
      </div>

      <footer style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-4, 8px)" }}>
        {ext.installed && onToggle ? (
          <button
            type="button"
            onClick={() => onToggle(ext, false)}
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-md, 6px)",
              padding: "var(--space-2, 4px) var(--space-6, 12px)",
              cursor: "pointer",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            Disable
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onInstall(ext)}
            style={{
              background: "var(--brand)",
              color: "var(--brand-fg)",
              border: "none",
              borderRadius: "var(--radius-md, 6px)",
              padding: "var(--space-2, 4px) var(--space-6, 12px)",
              cursor: "pointer",
              fontSize: "var(--text-small-size, 0.8125rem)",
              fontWeight: 600,
            }}
          >
            Install
          </button>
        )}
      </footer>
    </article>
  );
}
