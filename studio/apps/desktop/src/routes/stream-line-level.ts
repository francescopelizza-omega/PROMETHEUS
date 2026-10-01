// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/stream-line-level.ts — ONE classifier for every streamed engine line.
 *
 * `StreamLog` derives both its tint and its level glyph purely from `level`, so a caller
 * that maps its lines to `{id, text}` and nothing else gets a uniform grey wall with blank
 * glyphs. That is what BOTH long-running streams did — the catalog install log (handoff_3
 * §2: "coloured lines — command muted, fetch/unpack body, scan green, findings amber,
 * suppressed grey, verdict amber") and the security remediation feed (§4: "✓ done green, …
 * active amber"). Two specs, two panes, the same missing field.
 *
 * They share a classifier rather than growing one each, because the two engine surfaces
 * emit overlapping vocabulary — a nemesis scan line appears in both — and a local twin is
 * how one of them silently stops matching the other.
 *
 * ## The rule this file follows
 *
 * MARKERS AND PREFIXES ONLY, and `info` when unsure. Every level here paints a colour and
 * stamps a glyph, so a wrong guess is a claim: a green ✓ beside a line that never reported
 * success is worse than the grey it replaced. Nothing infers success from adjectives.
 */

/** The subset of `StreamLogLine["level"]` this classifier can assign. */
export type StreamLineLevel = "info" | "debug" | "warn" | "error" | "success";

/**
 * The engine's OWN level token, which every `Log` method stamps as a WORD, not a glyph
 * (prometheus.py's `Log.info/ok/warn/err/step/debug`).
 *
 * This is the vocabulary that actually reaches these two panes: the engine runs with
 * `--json --no-color`, which reroutes `Log.STREAM` to stderr, and main forwards those lines
 * verbatim (catalog-ipc's `progressSink`, security-ipc's `onStderr`). The glyph table below was
 * written against a prototype that never emitted any of it, so nothing matched and both panes
 * stayed a uniform grey — including `FAIL …`, a hard failure tinted neutral.
 *
 * The level a prefix implies is a FLOOR, not an override: a rule below may escalate it
 * (`WARN verdict: BLOCK` is an error) but must not weaken it (`OK source previously approved`
 * has no keyword in its remainder and must stay green).
 */
const ENGINE_PREFIX: readonly (readonly [RegExp, StreamLineLevel])[] = [
  [/^OK\s+/, "success"],
  [/^FAIL\s+/, "error"],
  [/^WARN\s+/, "warn"],
  [/^::\s+/, "info"],
  // `-> ` (Log.step) and `dbg ` (Log.debug) are NOT stripped or levelled here: they encode the
  // engine's step hierarchy through their four-space indent, and consuming them flattens the
  // pipeline into an undifferentiated list.
];

/** Level strength, so a prefix floor and a rule result can be combined without either
 *  blindly winning. */
const RANK: Readonly<Record<StreamLineLevel, number>> = {
  info: 0,
  debug: 1,
  success: 2,
  warn: 3,
  error: 4,
};

/** The stronger of two levels (an absent floor loses to anything). */
function strongest(a: StreamLineLevel | undefined, b: StreamLineLevel): StreamLineLevel {
  if (a === undefined) return b;
  return RANK[a] >= RANK[b] ? a : b;
}

/** Leading markers the engines emit. Checked first — they are unambiguous. */
const MARKER: readonly (readonly [RegExp, StreamLineLevel])[] = [
  [/^[✓✔]/, "success"],
  [/^[✗✕❌]/, "error"],
  [/^(…|\.\.\.)/, "warn"],
  [/^[▲⚠]/, "warn"],
  // a shell command the host is about to run — muted, it is provenance, not an outcome
  [/^\$\s/, "debug"],
];

/**
 * Classify one streamed line.
 *
 * `kind` narrows the vocabulary to the pane's own: the catalog's install pipeline speaks
 * `fetch` / `unpack` / `nemesis scan` / `verdict:`, which mean nothing in a remediation
 * stream and should not be matched there.
 */
export function streamLineLevel(
  text: string,
  kind: "lifecycle" | "remediation" = "remediation",
): StreamLineLevel {
  const t = text.trim();
  if (!t) return "info";

  // The engine's own level word first: it sets a FLOOR and is consumed, so the rules below see
  // the message rather than the prefix (`^verdict:` could never match "WARN verdict: …").
  let floor: StreamLineLevel | undefined;
  let body = t;
  for (const [re, lvl] of ENGINE_PREFIX) {
    if (re.test(body)) {
      floor = lvl;
      body = body.replace(re, "");
      break;
    }
  }

  for (const [re, level] of MARKER) if (re.test(body)) return strongest(floor, level);

  const low = body.toLowerCase();

  // A FINDING line, printed raw (no Log prefix reaches it): "HIGH [N-204] setup.sh:41  desc".
  // Checked before the suppressed rule so a suppressed-context finding still carries its tier.
  if (/^(critical|high)\b/.test(low)) return "error";
  if (/^(medium|low)\b/.test(low) || /^\[[A-Z]+-\d+\]/.test(body)) return "warn";
  if (/^info\b/.test(low)) return "debug";
  // its two continuation lines are subordinate to the finding above them
  if (/^(↳|fix:)/.test(body)) return "debug";

  // Suppressed findings are greyed WHEREVER they appear (handoff §4's own wording) — but NOT the
  // verdict line, which always carries a "[N suppressed]" tail and whose own tier must win.
  if (/\bsuppress(ed)?\b/.test(low) && !/^verdict:/.test(low)) return "debug";

  if (kind === "lifecycle") {
    // the prototype's finding shape, kept so an "N-204 …" line still matches
    if (/^[A-Z]+-\d+\b/.test(body)) return "warn";
    // the scan itself completing is the good news in this pipeline
    if (/^(nemesis\s+)?scan\b/.test(low)) return strongest(floor, "success");
    if (/^verdict:/.test(low)) {
      /**
       * The verdict line carries its own tier, and BLOCK is not amber.
       *
       * Two vocabularies land here. `nemesis`'s gate verdict is allow/warn/block
       * (prometheus.py's `rc_verdict`), and a scan report's verdict is the HIGHEST active
       * severity — clean/critical/high/medium/low (`ScanReport.verdict`). Only the first was
       * handled, so `verdict: CRITICAL` — the most serious line the pipeline can print — came
       * out the same amber as a low-severity one.
       */
      // The TIER TOKEN only — the one word straight after `verdict:`. Matching the tier names
      // anywhere in the line is wrong: every verdict line carries a count breakdown
      // ("(crit 2 / high 0 / med 1 / low 0)"), so `\bhigh\b` fired on `high 0` and reported a
      // MEDIUM verdict as an error.
      const tier = /^verdict:\s*([a-z]+)/.exec(low)?.[1] ?? "";
      if (tier === "block" || tier === "critical" || tier === "high") return "error";
      if (tier === "allow" || tier === "clean") return "success";
      return "warn";
    }
    // fetch / unpack / staging: the body of the pipeline, neutral
    if (/^(fetch|unpack|stage|staging|download)\b/.test(low)) return floor ?? "info";
  }

  // outcome words, in either pane. `fail` is included on its own: it is the exact token
  // `Log.err` emits, and omitting it left every hard failure grey.
  if (/\b(error|fail|failed|failure|refused|blocked|cannot|could not|unable)\b/.test(low)) {
    return "error";
  }
  if (/\b(warn|warning|skipped|unresolved)\b/.test(low)) return strongest(floor, "warn");
  return floor ?? "info";
}

/** A classified line: the level to tint it, and the text to actually print. */
export interface ClassifiedLine {
  level: StreamLineLevel;
  text: string;
}

/**
 * Markers that, having set the level, must not ALSO be printed.
 *
 * Includes the engine's three OUTCOME words (`OK`/`FAIL`/`WARN`) and `::`, because `StreamLog`
 * stamps its own glyph for exactly those levels. `-> ` and `dbg ` are deliberately left in place:
 * their indent is the engine's step hierarchy, not a duplicated gutter glyph.
 */
const MARKER_PREFIX = /^\s*(?:(?:✓|✔|✗|✕|❌|…|\.\.\.|▲|⚠|::)\s*|(?:OK|FAIL|WARN)\s+)/;

/**
 * Classify a line AND hand back the text to render.
 *
 * `StreamLog` stamps its own glyph per level (✓ for success, ▲ for warn, ✗ for error), so a
 * line that carries the marker in its own text renders it twice — "✓ ✓ removed postinstall
 * script". Reading the marker and then printing it as well was a regression introduced by
 * the very change that added the colours.
 *
 * The marker is stripped ONLY when it is what produced the level. A `⚠` in the middle of a
 * sentence, or a line whose level came from a keyword rather than a prefix, is untouched:
 * the goal is to avoid duplicating the gutter glyph, not to edit the engine's prose.
 */
export function classifyStreamLine(
  text: string,
  kind: "lifecycle" | "remediation" = "remediation",
): ClassifiedLine {
  const level = streamLineLevel(text, kind);
  const markerSetIt = MARKER_PREFIX.test(text) && level !== "info";
  return { level, text: markerSetIt ? text.replace(MARKER_PREFIX, "") : text };
}
