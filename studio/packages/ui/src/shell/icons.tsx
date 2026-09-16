/**
 * shell/icons.tsx — the Prometheus custom activity-icon set (file 08 §4.1).
 *
 * Hand-drawn inline SVGs (24px viewBox, bold 2.1px stroke, round joins) — bigger,
 * clearer and more recognisable than the unicode glyph fallback. Pure React +
 * inline SVG: NO icon-font / lucide hard-import, so the build stays green and the
 * style is fully ours (the brand→accent gradient + glow on the active item is the
 * "Prometheus is strong" cue). Keyed by the `icon` name already on each Activity
 * (Home, Code2, …) so the §4.1 data model is unchanged.
 *
 * `currentColor` drives the stroke, so the rail's button color (brand when active,
 * secondary otherwise) tints the glyph for free; `active` swaps the stroke to a
 * unique brand→accent gradient and adds a soft drop-shadow glow.
 */

import type { ReactElement, ReactNode } from "react";

import { type ActivityIconName, hasActivityIcon } from "./icon-names.js";

export { hasActivityIcon } from "./icon-names.js";

export interface ActivityIconProps {
  /** the Activity.icon name (Home, Code2, LayoutGrid, …). */
  name: string;
  /** rendered px size (square). Default 24. */
  size?: number;
  /** the active rail item — paints the brand→accent gradient + glow. */
  active?: boolean;
  /** override stroke width (default 2.1, 2.35 when active). */
  strokeWidth?: number;
}

/** The 24px path geometry for each icon name (stroke, fill:none). Typed by the canonical
 *  name union so a name without geometry — or geometry without a name — is a TYPE error. */
const PATHS: Record<ActivityIconName, ReactNode> = {
  // ⌂ home — roof + body
  Home: (
    <>
      <path d="M3 10.8 12 3l9 7.8" />
      <path d="M5.2 9.4V20h13.6V9.4" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  // ⌨ editor — </>
  Code2: (
    <>
      <path d="M8.5 7 3.5 12l5 5" />
      <path d="M15.5 7l5 5-5 5" />
      <path d="M13.5 4.5 10.5 19.5" />
    </>
  ),
  // ⬚ catalog — 2×2 grid
  LayoutGrid: (
    <>
      <rect x="3" y="3" width="7.2" height="7.2" rx="1.6" />
      <rect x="13.8" y="3" width="7.2" height="7.2" rx="1.6" />
      <rect x="3" y="13.8" width="7.2" height="7.2" rx="1.6" />
      <rect x="13.8" y="13.8" width="7.2" height="7.2" rx="1.6" />
    </>
  ),
  // 💬 chat — speech bubble + dots
  MessageSquare: (
    <>
      <path d="M20.5 12.2a2.3 2.3 0 0 1-2.3 2.3H9l-4.5 4V5.8a2.3 2.3 0 0 1 2.3-2.3h11.4a2.3 2.3 0 0 1 2.3 2.3z" />
      <path d="M8.5 9h7M8.5 12h4" />
    </>
  ),
  // ◴ models — bold 3D cube
  Boxes: (
    <>
      <path d="M12 2.6 3.2 7.3v9.4L12 21.4l8.8-4.7V7.3z" />
      <path d="M3.4 7.4 12 12l8.6-4.6" />
      <path d="M12 12v9.2" />
    </>
  ),
  // ⬢ environments — hexagon node
  Container: (
    <>
      <path d="M12 2.4 20.6 7v10L12 21.6 3.4 17V7z" />
      <circle cx="12" cy="12" r="3.3" />
    </>
  ),
  // 🛡 security — shield + check
  ShieldCheck: (
    <>
      <path d="M12 2.6 4.8 5.6v5.2c0 4.7 3.1 7.9 7.2 9.4 4.1-1.5 7.2-4.7 7.2-9.4V5.6z" />
      <path d="M8.6 11.8 11 14.2l4.6-4.7" />
    </>
  ),
  // ⤳ repos — git branch
  GitBranch: (
    <>
      <path d="M6.5 4v9" />
      <circle cx="6.5" cy="17" r="2.6" />
      <circle cx="17.5" cy="7" r="2.6" />
      <path d="M17.5 9.6c0 4.6-3.7 4.4-7.5 5.8" />
    </>
  ),
  // 📖 docs — open book
  BookOpen: (
    <>
      <path d="M12 5.4C9.8 4 6.6 4 3.8 5.2v13c2.8-1.2 6-1.2 8.2.2 2.2-1.4 5.4-1.4 8.2-.2v-13C17.4 4 14.2 4 12 5.4z" />
      <path d="M12 5.4v13" />
    </>
  ),
  // ⚙ extensions — jigsaw puzzle piece (lucide "puzzle", ISC)
  Puzzle: (
    <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.49-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.435.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
  ),
  // ◐ engine — activity pulse
  Activity: <path d="M3 12h3.6l2.4-6.8 4.4 13.6 2.4-6.8H21" />,
  // ⚙ settings — notched cog (lucide "settings", ISC)
  Settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  // ── editor inner-rail icons (APP-071) — same 24px stroke house style ──────────
  // ⌂ explorer — folder
  Files: (
    <path d="M3 6.6A1.6 1.6 0 0 1 4.6 5h3.5a1.6 1.6 0 0 1 1.25.6L10.7 7.2h8.7A1.6 1.6 0 0 1 21 8.8v8.6A1.6 1.6 0 0 1 19.4 19H4.6A1.6 1.6 0 0 1 3 17.4z" />
  ),
  // ⌕ search — magnifier
  Search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.4" />
      <path d="M20 20l-4.6-4.6" />
    </>
  ),
  // ⊕ debug — bug body + antennae + legs
  Bug: (
    <>
      <rect x="8" y="8" width="8" height="10" rx="4" />
      <path d="M9 8.2 7.2 5.6M15 8.2l1.8-2.6M8 12H3.8M16 12h4.2M8.2 15.8H4M15.8 15.8H20" />
    </>
  ),
  // ✓ tests — lab flask
  FlaskConical: (
    <>
      <path d="M9.5 3v6.4L4.8 17a2 2 0 0 0 1.7 3.1h11a2 2 0 0 0 1.7-3.1L14.5 9.4V3" />
      <path d="M8.4 3h7.2M7.6 13.6h8.8" />
    </>
  ),
  // ☑ todo — checklist
  ListChecks: (
    <path d="M4 6.4 5.4 7.8 8 5M4 12.4l1.4 1.4L8 11M11 6.6h9M11 13h9M4.4 18.6h.02M11 18.6h9" />
  ),
  // ≣ outline — indented tree list
  ListTree: <path d="M9.5 6h10.5M13 12h7M13 18h7M5 5v9.5a2 2 0 0 0 2 2h2M5 5.02h.02" />,
  // ⋔ call hierarchy — caller → callees
  CallHierarchy: (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="12" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <path d="M8.4 6.6h4.6a2 2 0 0 1 2 2v1.2M8.4 17.4h4.6a2 2 0 0 0 2-2v-1.2" />
    </>
  ),
  // ⤨ type hierarchy — supertype ↓ subtypes
  TypeHierarchy: (
    <>
      <circle cx="12" cy="5" r="2.4" />
      <circle cx="6" cy="19" r="2.4" />
      <circle cx="18" cy="19" r="2.4" />
      <path d="M12 7.4v2.1a2 2 0 0 1-2 2H8a2 2 0 0 0-2 2v1M12 9.5a2 2 0 0 0 2 2h2a2 2 0 0 1 2 2v1" />
    </>
  ),
  // ◔ blame — clock (who/when)
  // A spine with three siblings — the methods hanging off one type. Deliberately NOT the
  // zigzag of `CallHierarchy` (who calls whom) nor the Y-tree of `TypeHierarchy` (what
  // extends what): all three are hierarchies, so they have to differ by SHAPE, not by label.
  MethodHierarchy: (
    <>
      <path d="M6 5v13M6 5h6.9M6 11.5h6.9M6 18h6.9" />
      <circle cx="15.7" cy="5" r="2.4" />
      <circle cx="15.7" cy="11.5" r="2.4" />
      <circle cx="15.7" cy="18" r="2.4" />
    </>
  ),

  // A percent sign inside a ring: coverage is a MEASURED PROPORTION, which is exactly what
  // the old flask did not say — that glyph belongs to Tests, and Coverage was borrowing it.
  Coverage: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M9.2 14.8l5.6-5.6" />
      <circle cx="9.5" cy="9.5" r="1.15" />
      <circle cx="14.5" cy="14.5" r="1.15" />
    </>
  ),

  History: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.4V12l3.2 2" />
    </>
  ),
  // 📄 open file — document with lines
  FileText: (
    <>
      <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
      <path d="M13.5 3v5.5H19M8.6 13h6.8M8.6 16.5h6.8M8.6 9.5h2" />
    </>
  ),
  // 📂 open folder — folder with open flap
  FolderOpen: (
    <path d="M4 8V6.6A1.6 1.6 0 0 1 5.6 5h3.4l2 2.2h6A1.6 1.6 0 0 1 18.6 8.8v1.2M3.2 19h13.9a1 1 0 0 0 .96-.72l1.6-5.6A1 1 0 0 0 18.7 11.4H7.5a1 1 0 0 0-.96.72L4.7 18.9" />
  ),
};

/** Render the Prometheus activity icon for `name`; falls back to a dot if unknown. */
export function ActivityIcon({
  name,
  size = 24,
  active = false,
  strokeWidth,
}: ActivityIconProps): ReactElement {
  // `name` is a free string (callers pass Activity.icon); an unknown name falls back to a dot.
  const body = PATHS[name as ActivityIconName] ?? <circle cx="12" cy="12" r="3" />;
  const gradId = `prom-icn-${name}`;
  const sw = strokeWidth ?? (active ? 2.35 : 2.1);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? `url(#${gradId})` : "currentColor"}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={
        active
          ? { filter: "drop-shadow(0 0 5px color-mix(in srgb, var(--brand) 65%, transparent))" }
          : undefined
      }
    >
      {active && (
        <defs>
          <linearGradient id={gradId} x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0" style={{ stopColor: "var(--brand)" }} />
            <stop offset="1" style={{ stopColor: "var(--accent)" }} />
          </linearGradient>
        </defs>
      )}
      {body}
    </svg>
  );
}
