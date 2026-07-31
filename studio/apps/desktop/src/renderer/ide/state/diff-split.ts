/**
 * ide/state/diff-split.ts — split a unified git diff into its two sides (file 07 §6.2).
 *
 * `git diff` returns a UNIFIED diff string; a Monaco side-by-side diff editor needs the
 * ORIGINAL and MODIFIED text. This reconstructs both from the hunk bodies: context lines
 * (" ") go to both sides, removed ("-") to original only, added ("+") to modified only.
 * It faithfully represents the CHANGED regions (with context) — not the whole file, which
 * the diff doesn't carry — so the editor shows true red/green side-by-side instead of flat
 * unified text. PURE — no monaco/react — node:test-able.
 */

export interface DiffSides {
  original: string;
  modified: string;
}

/** Split a unified diff into original/modified text (hunk regions, with context). */
export function splitUnifiedDiff(diff: string): DiffSides {
  const original: string[] = [];
  const modified: string[] = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue; // the @@ -a,b +c,d @@ header itself isn't content
    }
    if (!inHunk) continue; // skip the file preamble (diff --git, index, ---, +++)
    const tag = line[0];
    const text = line.slice(1);
    if (tag === "+") {
      modified.push(text);
    } else if (tag === "-") {
      original.push(text);
    } else if (tag === "\\") {
      // "\ No newline at end of file" — a marker, not content.
    } else if (tag === " ") {
      original.push(text);
      modified.push(text);
    } else if (line === "") {
      // a bare blank line inside a hunk is context on both sides.
      original.push("");
      modified.push("");
    }
    // any other leading char (shouldn't occur inside a hunk) is ignored.
  }
  return { original: original.join("\n"), modified: modified.join("\n") };
}
