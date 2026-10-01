// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/diagnose.ts — PURE structured retry hints for a failed edit (WRAPPER Phase A).
 *
 * A deterministic ladder that fails CLOSED is only useful if the model can recover on the
 * next round. diagnoseFailedEdit turns a typed failure into a copy-pasteable hint: when the
 * block exists but whitespace drifted, it hands back the file's EXACT bytes for that region
 * (so the model's next `old` matches at the exact rung); when it doesn't, it points at the
 * nearest line + the whitespace delta; when ambiguous, it reports the sites and asks for more
 * surrounding context. Never fabricates — every hint is grounded in the actual file bytes.
 */

const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) as RegExpExecArray)[0];
const hstrip = (s: string): string => s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
const isBlank = (s: string): boolean => /^[ \t]*$/.test(s);

export interface RetryHint {
  code: "empty" | "no-match" | "ambiguous";
  /** a single-line, model-facing message. */
  message: string;
  /** the file's exact text for the located region (copy-paste as the corrected `old`). */
  correctedOld?: string;
  /** 1-based file line numbers of candidate sites (for ambiguous / nearest). */
  sites?: number[];
  /** a human note on the whitespace difference at the nearest site. */
  whitespaceHint?: string;
}

/** Trimmed-equal window search used only to BUILD a hint (never to apply). */
function trimmedWindows(fileLines: string[], oldLines: string[]): number[] {
  const want = oldLines.map(hstrip);
  const m = want.length;
  const hits: number[] = [];
  if (m === 0 || m > fileLines.length) return hits;
  for (let i = 0; i + m <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < m; k++) {
      if (hstrip(fileLines[i + k] as string) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** char-bigram Dice coefficient (0..1) — cheap, no deps; used only to rank a nearest line. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bg = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bg(a);
  const mb = bg(b);
  let inter = 0;
  for (const [g, c] of ma) inter += Math.min(c, mb.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/**
 * Diagnose a failed hunk against the normalized `work`. `oldN` is the model's pre-image and
 * `code` the typed failure. Pure — safe to call after any refusal.
 */
export function diagnoseFailedEdit(
  work: string,
  oldN: string,
  code: "empty" | "no-match" | "ambiguous",
): RetryHint {
  if (code === "empty" || oldN === "") {
    return { code: "empty", message: "the `old` text was empty — send the exact text to replace." };
  }
  const fileLines = work.split("\n");
  const oldLines = oldN.replace(/\n$/, "").split("\n");

  if (code === "ambiguous") {
    // report the exact-substring sites so the model can add disambiguating context.
    const sites: number[] = [];
    let from = 0;
    for (;;) {
      const idx = work.indexOf(oldN, from);
      if (idx === -1) break;
      sites.push(work.slice(0, idx).split("\n").length);
      from = idx + Math.max(1, oldN.length);
    }
    return {
      code,
      message: `\`old\` matches ${sites.length || "multiple"} locations — add a unique surrounding line so exactly one matches.`,
      sites,
    };
  }

  // no-match: does the block exist modulo whitespace?
  const tw = trimmedWindows(fileLines, oldLines);
  if (tw.length === 1) {
    const i = tw[0] as number;
    const exact = fileLines.slice(i, i + oldLines.length).join("\n");
    const fileLead = leadingWs(fileLines[i] as string);
    const oldLead = leadingWs(oldLines[0] as string);
    const wsHint =
      fileLead !== oldLead
        ? `indentation differs: file uses ${JSON.stringify(fileLead)}, your \`old\` used ${JSON.stringify(oldLead)}.`
        : "trailing/interior whitespace differs.";
    return {
      code,
      message:
        "found the block but its whitespace differs — copy the file's exact text below as `old`.",
      correctedOld: exact,
      sites: [i + 1],
      whitespaceHint: wsHint,
    };
  }
  if (tw.length > 1) {
    return {
      code,
      message: `the block appears ${tw.length} times ignoring whitespace — include more surrounding context.`,
      sites: tw.map((i) => i + 1),
    };
  }

  // nothing close by lines — point at the single most-similar non-blank line.
  const target = oldLines.find((l) => !isBlank(l)) ?? (oldLines[0] as string);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < fileLines.length; i++) {
    const s = similarity(hstrip(fileLines[i] as string), hstrip(target));
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  if (best !== -1 && bestScore >= 0.5) {
    return {
      code,
      message: `no exact match. nearest line ${best + 1}: ${JSON.stringify((fileLines[best] as string).slice(0, 80))} — re-read the file around there.`,
      sites: [best + 1],
    };
  }
  return { code, message: "no match found — re-read the file; the region may have changed." };
}
