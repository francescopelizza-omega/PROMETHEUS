/**
 * Panel.tsx — a surface container (08 §2.4 elevation, §4 layout).
 *
 * The dev-tool look leans on 1px hairline BORDERS, not shadows (08 §2.4), so the
 * default elevation is e1 (a bordered card). Optional header row with a title +
 * trailing actions slot matches the §5 wireframe panels (SECURITY / MODELS /
 * ENV cards, the catalog detail pane, etc.). All color/space via tokens.
 */

import type { ReactElement, ReactNode } from "react";

export type Elevation = "e0" | "e1" | "e2" | "e3";

const ELEVATION_SHADOW: Record<Elevation, string> = {
  e0: "none",
  e1: "none", // the border IS the elevation (08 §2.4)
  e2: "0 8px 24px rgba(0,0,0,.35)",
  e3: "0 16px 48px rgba(0,0,0,.5)",
};

export interface PanelProps {
  /** Optional header title (string or node, e.g. with a leading glyph). */
  title?: ReactNode;
  /** Trailing actions rendered at the right of the header. */
  actions?: ReactNode;
  elevation?: Elevation;
  /** Use the raised surface (--bg-surface-2) instead of --bg-surface. */
  raised?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Panel({
  title,
  actions,
  elevation = "e1",
  raised = false,
  className,
  children,
}: PanelProps): ReactElement {
  const hasHeader = title != null || actions != null;
  return (
    <section
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        background: raised ? "var(--bg-surface-2)" : "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-lg, 10px)",
        boxShadow: ELEVATION_SHADOW[elevation],
        color: "var(--text-primary)",
        overflow: "hidden",
      }}
    >
      {hasHeader && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-4, 8px)",
            paddingInline: "var(--space-6, 12px)",
            paddingBlock: "var(--space-4, 8px)",
            borderBottom: "1px solid var(--border-subtle)",
            fontFamily: "var(--font-ui)",
            fontSize: "var(--text-h2-size, 1.125rem)",
            fontWeight: 600,
          }}
        >
          <div
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </div>
          {actions != null && (
            <div
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2, 4px)" }}
            >
              {actions}
            </div>
          )}
        </header>
      )}
      <div
        style={{
          padding: "var(--space-6, 12px)",
          flex: 1,
          minHeight: 0,
          // wrap long paths/URLs/JSON so they don't spill past the panel — but use
          // `break-word` (NOT `anywhere`): `anywhere` shrinks the min-content width so a
          // narrow flex/grid column collapses to ~1ch and text wraps one char per line.
          // `break-word` only breaks an over-long word, leaving normal text horizontal.
          minWidth: 0,
          overflowWrap: "break-word",
        }}
      >
        {children}
      </div>
    </section>
  );
}

export default Panel;
