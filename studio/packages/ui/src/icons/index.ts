/**
 * icons/ barrel (08 §2.5 + §3 tree). The custom engine-concept set (Prometheus
 * flame, nemesis shield, verdict glyphs) plus the lucide-react re-exports the
 * activity rail + chrome use, so every surface imports icons from ONE place.
 *
 * lucide-react is MIT, tree-shakeable, and the dev-tool line aesthetic (08 §2.5);
 * the activity-rail entries (shell/activities.ts) name a lucide icon per activity.
 */

export { Flame } from "./flame.js";
export { Shield } from "./shield.js";
export { VerdictGlyph } from "./verdict.js";
export type { VerdictGlyphProps } from "./verdict.js";

/* lucide-react re-exports — the activity-rail + pinned icons (shell/activities.ts
 * `icon` field) and common chrome glyphs. Re-exported so consumers depend on
 * @prometheus/ui, not lucide directly (one swap point if the icon set changes). */
export {
  Home,
  Code2,
  LayoutGrid,
  Boxes,
  Container,
  ShieldCheck,
  GitBranch,
  Puzzle,
  // lucide's `Activity` (pulse) icon — aliased to avoid clashing with the
  // shell `Activity` (activity-rail entry) type re-exported at the package root.
  Activity as ActivityIcon,
  Settings as SettingsIcon,
  Search as SearchIcon,
  Terminal as TerminalIcon,
  Play as PlayIcon,
  Square as SquareIcon,
  Download as DownloadIcon,
  RefreshCw as RefreshIcon,
} from "lucide-react";
