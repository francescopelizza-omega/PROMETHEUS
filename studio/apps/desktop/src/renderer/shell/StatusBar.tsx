// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/StatusBar.tsx — the 26px "always-true facts" bar (handoff §7, file 08 §4.2/§5.6).
 *
 * §7's exact ordering, left → right:
 *   🛡 gate armed · A{n} name (click = picker) · ⎇ branch · ⚠ problems (real count)
 *   · [spacer] · engine dot+state · active model · encoding · ⌘K
 *
 * The shield STATE is computed by the shared shell brain (deriveShield); this component
 * never invents a color/verdict (C5/§6) — an entry that carries meaning passes a semantic
 * token NAME as `tone`, and the primitive resolves it.
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

import { authLevelUiLabel, authLevelVar, useAuthorisationStore } from "../stores/authorisation.js";
import type { HealthPill } from "../stores/health-derive.js";

const ENGINE_VAR: Record<HealthPill, string> = {
  ready: "--ok",
  degraded: "--warn",
  down: "--danger",
  unknown: "--text-disabled",
};

const ENGINE_SHORT: Record<HealthPill, string> = {
  ready: "engine ✓",
  degraded: "engine ◐",
  down: "engine ✕",
  unknown: "engine ?",
};

export interface ShellStatusBarProps {
  /** the latest gate verdict tier (null before the first gate ran). */
  verdict: VerdictTier | null;
  /** whether the nemesis threat DB is stale (drives the "stale" shield). */
  dbStale?: boolean;
  /**
   * Whether the SCANNER is present at all (`HealthResult.nemesisPresent`).
   *
   * A different question from "what did the last scan say", and the shield answers the
   * wrong one without it: a null verdict falls to `deriveShield`'s benign `clean`
   * placeholder, so a build with nemesis missing painted a green shield in the one piece of
   * chrome that is always on screen. `undefined` = no probe yet, which keeps the previous
   * behaviour rather than accusing a scanner nobody looked for.
   */
  armed?: boolean;
  /** active venv label, e.g. "py3.12 (prometheus)" — shown only when one is active. */
  venv?: string;
  /** served model label, e.g. "qwen3:8b". */
  model?: string;
  /** git branch + ahead/behind, e.g. "main ↑2". */
  branch?: string;
  /** problem counts (errors / warnings) from LSP + nemesis findings. */
  problems?: { errors: number; warnings: number };
  /** the engine health pill — the §7 `engine dot+state` entry. */
  enginePill?: HealthPill;
  /** click the engine entry → open the Health panel. */
  onEngineClick?(): void;
  /** the active file's encoding (§7). Defaults to UTF-8, which is what the editor writes. */
  encoding?: string;
  /** compact update-flow state (APP-005) — label mirrors the banner's phase. */
  update?: { label: string; title?: string; onClick?: () => void };
  /** click the shield → open the Security activity (08 §4.2). */
  onShieldClick(): void;
  /** click the problems counter → focus the Problems bottom tab (APP-009). */
  onProblemsClick?(): void;
  /** click the auth entry → open the level picker (§5). */
  onAuthClick?(): void;
  /** open the ⌘K palette from the hint. */
  onCommandPalette(): void;
}

export function ShellStatusBar({
  verdict,
  dbStale,
  armed,
  venv,
  model,
  branch,
  problems,
  enginePill = "unknown",
  onEngineClick,
  encoding = "UTF-8",
  update,
  onShieldClick,
  onProblemsClick,
  onAuthClick,
  onCommandPalette,
}: ShellStatusBarProps): ReactElement {
  const authLevel = useAuthorisationStore((s) => s.level);
  // The shield maps a stale/clean state back to a verdict TIER the base bar tints.
  const shield = deriveShield(verdict, { dbStale, ...(armed === undefined ? {} : { armed }) });
  // "stale" has no verdict tier of its own → render it as a warn-tinted shield, and an
  // ABSENT scanner as a danger one: the shield may not read benign while nothing is gated.
  const shieldTier: VerdictTier =
    shield.state === "unarmed"
      ? "block"
      : shield.state === "stale"
        ? "warn"
        : shield.state === "armed"
          ? "allow"
          : (verdict ?? "allow");

  /* ── left: the security + authority facts (§7) ─────────────────────────────── */
  const left: StatusItem[] = [
    {
      id: "auth",
      label: `A${authLevel} ${authLevelUiLabel(authLevel)}`,
      ariaLabel: `Authorisation level A${authLevel}, ${authLevelUiLabel(authLevel)}`,
      title: "Authorisation level — click to change",
      tone: authLevelVar(authLevel),
      ...(onAuthClick ? { onClick: onAuthClick } : {}),
    },
  ];
  if (branch) left.push({ id: "branch", glyph: "⎇", label: branch, title: "Git branch" });
  if (problems) {
    const { errors, warnings } = problems;
    left.push({
      id: "problems",
      glyph: "⚠",
      label: `${errors} ✖ ${warnings}`,
      title: "Problems (errors / warnings)",
      // the count is the signal: red when anything errors, amber when only warnings.
      ...(errors > 0 ? { tone: "--danger" } : warnings > 0 ? { tone: "--warn" } : {}),
      ...(onProblemsClick ? { onClick: onProblemsClick } : {}),
    });
  }

  /* ── right: the runtime facts (§7) ─────────────────────────────────────────── */
  const right: StatusItem[] = [];
  if (update) {
    right.push({
      id: "update",
      glyph: "⭳",
      label: update.label,
      title: update.title ?? "Application update",
      tone: "--accent",
      ...(update.onClick ? { onClick: update.onClick } : {}),
    });
  }
  right.push({
    id: "engine",
    glyph: "●",
    label: ENGINE_SHORT[enginePill],
    title: `Engine: ${enginePill}`,
    tone: ENGINE_VAR[enginePill],
    ...(onEngineClick ? { onClick: onEngineClick } : {}),
  });
  if (model) right.push({ id: "model", label: model, title: "Served model" });
  // the venv is not one of §7's nine entries, but it IS an always-true fact when a
  // project has one — keep it, quietly, rather than silently dropping a real signal.
  if (venv) right.push({ id: "venv", glyph: "⬢", label: venv, title: "Active environment" });
  right.push({ id: "encoding", label: encoding, title: "File encoding" });
  right.push({
    id: "cmdk",
    label: "⌘K",
    title: "Command palette",
    tone: "--text-secondary",
    onClick: onCommandPalette,
  });

  return (
    <BaseStatusBar shield={shieldTier} onShieldClick={onShieldClick} left={left} right={right} />
  );
}

export default ShellStatusBar;
