/**
 * security/progress.ts — parse a nemesis stderr progress line into a typed scan STAGE (CLI-040).
 *
 * `runNemesis` already line-buffers stderr and hands `onStderr` COMPLETE lines; this maps a line
 * to one of four ordered stages (resolve → static rules → threat feeds → verdict) so `prometheus secure
 * scan` can print `[i/4] <label> — <detail>` on a stage transition instead of raw noise. This
 * nemesis build emits little-to-no stderr in --json mode, so the patterns are keyed defensively
 * off nemesis' source wording (fetching/scanning/feeds/verdict); ANY unrecognized line degrades
 * to the generic "scan" stage (index 0) — it NEVER throws, so a future nemesis wording change
 * downgrades granularity rather than crashing a scan. Pure: no I/O, no state.
 */

/** The ordered scan stages (+ the "scan" catch-all for unclassified lines). */
export type ScanStageId = "resolve" | "static" | "threatdb" | "verdict" | "scan";

export interface ScanStage {
  stage: ScanStageId;
  /** Human label for the stage (e.g. "static rules"). */
  label: string;
  /** The cleaned source line (ANSI-stripped, trimmed) — the `<detail>` shown after the label. */
  detail: string;
  /** 1-based position among the ordered stages, or 0 for the generic "scan" catch-all. */
  index: number;
}

/** The ordered, numbered stages (the "N" in `[i/N]`). "scan" is deliberately excluded. */
const STAGE_ORDER: ScanStageId[] = ["resolve", "static", "threatdb", "verdict"];
export const SCAN_STAGE_COUNT = STAGE_ORDER.length;

const STAGE_LABEL: Record<ScanStageId, string> = {
  resolve: "resolve target",
  static: "static rules",
  threatdb: "threat feeds",
  verdict: "verdict",
  scan: "scanning",
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Map a single nemesis stderr line to its typed stage (never throws; unknown → "scan"). */
export function parseStageLine(raw: string): ScanStage {
  const detail = raw.replace(ANSI_RE, "").trim();
  const l = detail.toLowerCase();
  let stage: ScanStageId = "scan";
  if (/(fetch|resolv|clon|download|snapshot|checkout)/.test(l)) {
    stage = "resolve";
  } else if (/(static|rule|pattern|\bast\b|sast|secret|heuristic|yara)/.test(l)) {
    stage = "static";
  } else if (/(feed|threat|indicator|\bdb\b|\bioc\b|\bcve\b|osv|reputation|url|\bsca\b)/.test(l)) {
    stage = "threatdb";
  } else if (/(verdict|decision|risk score|complete|finished|done)/.test(l)) {
    stage = "verdict";
  }
  const at = STAGE_ORDER.indexOf(stage);
  return { stage, label: STAGE_LABEL[stage], detail, index: at >= 0 ? at + 1 : 0 };
}
