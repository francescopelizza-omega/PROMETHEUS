// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/blame-inline.ts — PURE inline-blame decoration math (APP-083).
 *
 * The editor's CURRENT line gets an after-content annotation
 * ("author, relative-date • short-sha") with a hover carrying the full sha, author,
 * ISO date, and summary — the GitLens "current line blame" affordance, alongside the
 * BlameView side panel. This module builds the plain decoration DESCRIPTOR
 * (structurally what Monaco's `createDecorationsCollection` consumes) with NO monaco
 * import, so it is node:test-able and the EditorPane stays the only Monaco toucher.
 *
 * Color comes from the `.prom-inline-blame` class (a theme-token rule in
 * styles/global.css) — raw hex here would be build-blocked by check-no-raw-hex.
 */

import type { IdeGitBlameEntry } from "../../../shared/ipc-contract.js";

/** The theme-token CSS class the injected annotation renders with (global.css). */
export const INLINE_BLAME_CLASS = "prom-inline-blame";

/** git's not-yet-committed line sha (all zeros, any length) — render no annotation. */
const UNCOMMITTED = /^0{7,40}$/;
export function isUncommitted(hash: string | undefined): boolean {
  return !hash || UNCOMMITTED.test(hash);
}

/** A compact "3d ago" label from a Unix epoch (seconds) relative to `nowMs`. */
export function relativeDate(epochSec: number, nowMs: number): string {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return "";
  const diff = Math.max(0, Math.floor(nowMs / 1000) - Math.floor(epochSec));
  if (diff < 60) return "just now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3600);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86400);
  if (days < 30) return `${days}d ago`;
  // gate months on the SAME 365-day boundary the year branch uses — gating on `months < 12`
  // (i.e. days < 360) left the 360–364-day gap falling through to `floor(days/365) === 0` → "0y".
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Index blame entries by their 1-based line, DROPPING uncommitted lines (all-zero
 * sha) and malformed rows — a truncated porcelain stream never crashes the caller.
 */
export function blameByLine(
  entries: readonly IdeGitBlameEntry[] | undefined,
): Map<number, IdeGitBlameEntry> {
  const map = new Map<number, IdeGitBlameEntry>();
  for (const e of entries ?? []) {
    if (!e || typeof e.line !== "number" || typeof e.hash !== "string") continue;
    if (isUncommitted(e.hash)) continue;
    map.set(e.line, e);
  }
  return map;
}

/** The inline annotation text (fields defaulted — a truncated entry never throws). */
export function inlineBlameText(e: IdeGitBlameEntry, nowMs: number): string {
  const author = e.author?.trim() || "Unknown";
  const rel = relativeDate(e.epoch, nowMs);
  const sha = (e.hash ?? "").slice(0, 8);
  return `${author}${rel ? `, ${rel}` : ""}${sha ? ` • ${sha}` : ""}`;
}

/** The hover markdown: full commit sha, author, ISO date, summary. */
export function inlineBlameHover(e: IdeGitBlameEntry): string {
  const author = e.author?.trim() || "Unknown";
  const summary = e.summary?.trim() || "(no summary)";
  const date = e.date?.trim() || "";
  return `\`${e.hash ?? ""}\`\n\n**${author}**${date ? ` · ${date}` : ""}\n\n${summary}`;
}

/** A structural subset of monaco.editor.IModelDeltaDecoration for the current line. */
export interface InlineBlameDecoration {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  options: {
    description: string;
    after: { content: string; inlineClassName: string };
    hoverMessage: { value: string };
    /** monaco.editor.TrackedRangeStickiness — injected by the caller (no monaco here). */
    stickiness: number;
  };
}

/**
 * Build the (single) current-line blame decoration, or [] when there is nothing to
 * show (no entry, an invalid line/column, or an uncommitted line). `stickiness` is
 * the Monaco enum value the caller passes so this stays monaco-free.
 */
export function buildInlineBlameDecoration(
  entry: IdeGitBlameEntry | undefined,
  endColumn: number,
  nowMs: number,
  stickiness: number,
): InlineBlameDecoration[] {
  if (!entry || typeof entry.line !== "number" || entry.line < 1 || endColumn < 1) return [];
  if (isUncommitted(entry.hash)) return [];
  return [
    {
      range: {
        startLineNumber: entry.line,
        startColumn: endColumn,
        endLineNumber: entry.line,
        endColumn,
      },
      options: {
        description: "prom-inline-blame",
        after: {
          content: `    ${inlineBlameText(entry, nowMs)}`,
          inlineClassName: INLINE_BLAME_CLASS,
        },
        hoverMessage: { value: inlineBlameHover(entry) },
        stickiness,
      },
    },
  ];
}
