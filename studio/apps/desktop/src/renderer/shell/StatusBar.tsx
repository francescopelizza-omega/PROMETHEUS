/**
 * shell/StatusBar.tsx — the §4.2 "always-true facts" bar (file 08 §4.2/§5.6).
 *
 * Binds the @prometheus/ui StatusBar primitive to live renderer state:
 *   - the permanent nemesis SHIELD (clean/warn/block/error/stale + glyph; click →
 *     opens the Security activity) derived from the latest gate tier via the PURE
 *     deriveShield() (08 §4.2), tinted by its role token,
 *   - active venv · served model · git branch · problem counts · ⌘K hint.
 *
 * The shield STATE is computed by the shared shell brain (deriveShield); this
 * component never invents a color/verdict (C5/§6). Data binds from the Zustand
 * security slice + props the workbench passes down.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the renderer stores only.
 */

import {
  StatusBar as BaseStatusBar,
  type StatusItem,
  type VerdictTier,
  deriveShield,
} from "@prometheus/ui";
import type { ReactElement } from "react";

export interface ShellStatusBarProps {
  /** the latest gate verdict tier (null before the first gate ran). */
  verdict: VerdictTier | null;
  /** whether the nemesis threat DB is stale (drives the "stale" shield). */
  dbStale?: boolean;
  /** active venv label, e.g. "py3.12 (prometheus)". */
  venv?: string;
  /** served model label, e.g. "qwen3:8b". */
  model?: string;
  /** git branch + ahead/behind, e.g. "main ↑2". */
  branch?: string;
  /** problem counts (errors / warnings) from LSP + nemesis findings. */
  problems?: { errors: number; warnings: number };
  /** compact update-flow state (APP-005) — label mirrors the banner's phase. */
  update?: { label: string; title?: string; onClick?: () => void };
  /** click the shield → open the Security activity (08 §4.2). */
  onShieldClick(): void;
  /** click the problems counter → focus the Problems bottom tab (APP-009). */
  onProblemsClick?(): void;
  /** open the ⌘K palette from the hint. */
  onCommandPalette(): void;
}

export function ShellStatusBar({
  verdict,
  dbStale,
  venv,
  model,
  branch,
  problems,
  update,
  onShieldClick,
  onProblemsClick,
  onCommandPalette,
}: ShellStatusBarProps): ReactElement {
  // The shield maps a stale/clean state back to a verdict TIER the base bar tints.
  const shield = deriveShield(verdict, { dbStale });
  // "stale" has no verdict tier of its own → render it as a warn-tinted shield.
  const shieldTier: VerdictTier = shield.state === "stale" ? "warn" : (verdict ?? "allow");

  const left: StatusItem[] = [];
  if (venv) left.push({ id: "venv", glyph: "⬢", label: venv, title: "Active environment" });
  if (model) left.push({ id: "model", glyph: "▶", label: model, title: "Served model" });

  const right: StatusItem[] = [];
  if (update) {
    right.push({
      id: "update",
      glyph: "⭳",
      label: update.label,
      title: update.title ?? "Application update",
      ...(update.onClick ? { onClick: update.onClick } : {}),
    });
  }
  if (branch) right.push({ id: "branch", glyph: "⎇", label: branch, title: "Git branch" });
  if (problems) {
    right.push({
      id: "problems",
      label: `${problems.errors}✖ ${problems.warnings}⚠`,
      title: "Problems (errors / warnings)",
      // the ui StatusItem primitive already supports onClick — wired, not forked.
      ...(onProblemsClick ? { onClick: onProblemsClick } : {}),
    });
  }
  right.push({
    id: "cmdk",
    label: "⌘K",
    title: "Command palette",
    onClick: onCommandPalette,
  });

  return (
    <BaseStatusBar shield={shieldTier} onShieldClick={onShieldClick} left={left} right={right} />
  );
}

export default ShellStatusBar;
