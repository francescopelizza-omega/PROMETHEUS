// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/merge-conflict.ts — the PURE 3-way conflict model (APP-039).
 *
 * Parses a working-tree file's git conflict markers into an ordered sequence of
 * common-text runs and conflict blocks (ours / base / theirs), holds a per-block
 * resolution (accept ours/theirs/both or manual free text), and serializes the
 * merged result back — re-emitting the file's ORIGINAL EOL so Monaco + git don't
 * show a spurious whole-file diff. Framework-free → node:test-ed independently of
 * Monaco. The MergeView renders it; Mark Resolved writes `buildResult` via the
 * path-guarded fs IPC and stages the file.
 *
 * Marker grammar (exactly 7 chars at line start, state-guarded so a legitimate
 * `=======` content line only counts as a separator INSIDE an open conflict):
 *   <<<<<<< ours      |||||||  base (diff3/zdiff3 only)      =======      >>>>>>> theirs
 */

export type Resolution = "unresolved" | "ours" | "theirs" | "both" | "manual";

export type Segment =
  | { kind: "common"; lines: string[] }
  | {
      kind: "conflict";
      ours: string[];
      /** the merge-base section (diff3/zdiff3); null when git used the 2-way style. */
      base: string[] | null;
      theirs: string[];
      resolution: Resolution;
      /** free-text override when resolution === "manual". */
      manual?: string;
    };

export interface ParsedMerge {
  segments: Segment[];
  /** the file's detected line ending, re-emitted verbatim by buildResult. */
  eol: "\n" | "\r\n";
  /** how many conflict blocks the file has. */
  conflictCount: number;
}

const OURS_RE = /^<{7}(?:\s|$)/;
const BASE_RE = /^\|{7}(?:\s|$)/;
const SEP_RE = /^={7}(?:\s|$)/;
const THEIRS_RE = /^>{7}(?:\s|$)/;

/** Parse working-tree text with conflict markers into the ordered segment model. */
export function parseConflicts(text: string): ParsedMerge {
  const eol: "\n" | "\r\n" = /\r\n/.test(text) ? "\r\n" : "\n";
  // split on \n and strip a trailing \r for detection; content keeps no \r (re-added by EOL).
  const rawLines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const segments: Segment[] = [];
  let common: string[] = [];
  let i = 0;
  let conflictCount = 0;

  const flushCommon = (): void => {
    if (common.length > 0) {
      segments.push({ kind: "common", lines: common });
      common = [];
    }
  };

  while (i < rawLines.length) {
    const line = rawLines[i] ?? "";
    if (OURS_RE.test(line)) {
      flushCommon();
      const ours: string[] = [];
      const base: string[] = [];
      const theirs: string[] = [];
      let hasBase = false;
      i++;
      // ours: until ||||||| or =======
      while (
        i < rawLines.length &&
        !BASE_RE.test(rawLines[i] ?? "") &&
        !SEP_RE.test(rawLines[i] ?? "")
      ) {
        ours.push(rawLines[i] ?? "");
        i++;
      }
      // optional base section (diff3/zdiff3)
      if (i < rawLines.length && BASE_RE.test(rawLines[i] ?? "")) {
        hasBase = true;
        i++;
        while (i < rawLines.length && !SEP_RE.test(rawLines[i] ?? "")) {
          base.push(rawLines[i] ?? "");
          i++;
        }
      }
      // separator =======
      if (i < rawLines.length && SEP_RE.test(rawLines[i] ?? "")) i++;
      // theirs: until >>>>>>>
      while (i < rawLines.length && !THEIRS_RE.test(rawLines[i] ?? "")) {
        theirs.push(rawLines[i] ?? "");
        i++;
      }
      // closing >>>>>>>
      if (i < rawLines.length && THEIRS_RE.test(rawLines[i] ?? "")) i++;
      segments.push({
        kind: "conflict",
        ours,
        base: hasBase ? base : null,
        theirs,
        resolution: "unresolved",
      });
      conflictCount++;
    } else {
      common.push(line);
      i++;
    }
  }
  flushCommon();
  return { segments, eol, conflictCount };
}

/** Number of still-undecided conflict blocks. */
export function unresolvedCount(merge: ParsedMerge): number {
  return merge.segments.filter((s) => s.kind === "conflict" && s.resolution === "unresolved")
    .length;
}

function setResolution(
  merge: ParsedMerge,
  index: number,
  resolution: Resolution,
  manual?: string,
): ParsedMerge {
  let seen = -1;
  const segments = merge.segments.map((s) => {
    if (s.kind !== "conflict") return s;
    seen++;
    if (seen !== index) return s;
    return { ...s, resolution, ...(manual !== undefined ? { manual } : {}) };
  });
  return { ...merge, segments };
}

/** Resolve the `index`-th conflict block (0-based over conflict blocks only). */
export function acceptOurs(merge: ParsedMerge, index: number): ParsedMerge {
  return setResolution(merge, index, "ours");
}
export function acceptTheirs(merge: ParsedMerge, index: number): ParsedMerge {
  return setResolution(merge, index, "theirs");
}
export function acceptBoth(merge: ParsedMerge, index: number): ParsedMerge {
  return setResolution(merge, index, "both");
}
/** Set free-text for a block (flips it to `manual`). */
export function setManual(merge: ParsedMerge, index: number, text: string): ParsedMerge {
  return setResolution(merge, index, "manual", text);
}

/** The resolved lines a conflict block contributes to buildResult (unresolved → markers). */
function resolvedLines(seg: Extract<Segment, { kind: "conflict" }>, eol: "\n" | "\r\n"): string[] {
  switch (seg.resolution) {
    case "ours":
      return seg.ours;
    case "theirs":
      return seg.theirs;
    case "both":
      return [...seg.ours, ...seg.theirs]; // ours-then-theirs (VS Code convention)
    case "manual":
      return (seg.manual ?? "").split(/\r?\n/);
    default: {
      // unresolved → re-emit the original markers so the file round-trips losslessly.
      const markers = ["<<<<<<< ours", ...seg.ours];
      if (seg.base !== null) markers.push("||||||| base", ...seg.base);
      markers.push("=======", ...seg.theirs, ">>>>>>> theirs");
      void eol;
      return markers;
    }
  }
}

/** The current resolved text of one conflict block (for the editable result pane).
 *  An unresolved block shows its raw markers so the user can pick a side or edit. */
export function blockText(seg: Extract<Segment, { kind: "conflict" }>): string {
  return resolvedLines(seg, "\n").join("\n");
}

/** Serialize the merged file, re-emitting the original EOL. */
export function buildResult(merge: ParsedMerge): string {
  const out: string[] = [];
  for (const seg of merge.segments) {
    if (seg.kind === "common") out.push(...seg.lines);
    else out.push(...resolvedLines(seg, merge.eol));
  }
  return out.join(merge.eol);
}
