/**
 * appearance-view.ts — PURE renderer helpers for the Appearance panel (file 13 §3.2).
 *
 * The scheme registry + resolution + contrast gate are @prometheus/ui's `themes`
 * namespace (tested in packages/ui). This module owns only the renderer's display
 * shaping: the swatch-tile bars + the preview-triptych mock content — unit-testable
 * without a DOM.
 */

/** A swatch tile preview: three surface bars + an accent dot (file 13 §3.2). */
export interface SwatchTile {
  bars: [string, string, string];
  accent: string;
  brand: string;
}

/** Build a swatch tile from a resolved color map (keys = 08 SemanticColors). */
export function swatchTile(colors: Record<string, string>): SwatchTile {
  return {
    bars: [colors["bg-app"] ?? "", colors["bg-surface"] ?? "", colors["bg-surface-2"] ?? ""],
    accent: colors.accent ?? "",
    brand: colors.brand ?? "",
  };
}

/** A line of the live-preview triptych (§3.2). */
export interface PreviewLine {
  text: string;
  /** semantic role token for any colored span (e.g. a nemesis-flagged line). */
  role?: "ok" | "warn" | "danger" | "info" | "brand" | "accent";
}

/** The editor pane preview content (shows a nemesis-flagged line so verdict legibility is visible). */
export const PREVIEW_EDITOR: readonly PreviewLine[] = [
  { text: "1  def run(task):" },
  { text: "2    res = model.complete(ctx)" },
  { text: "3    return Result(res)  ⛔ PROM-OS-EXEC-001", role: "danger" },
];

/** The chrome preview content. */
export const PREVIEW_CHROME: readonly PreviewLine[] = [
  { text: "🛡 clean", role: "ok" },
  { text: "qwen3:8b ▶", role: "brand" },
  { text: "⎇ main" },
];

/** The terminal preview content. */
export const PREVIEW_TERMINAL: readonly PreviewLine[] = [
  { text: "(.venv)$ prom chat" },
  { text: "● prom ✓ CLEAN risk 4", role: "ok" },
  { text: "$ _" },
];
