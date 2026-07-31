/**
 * stream.ts — turn the engine's HUMAN stderr lines into progress events.
 *
 * There is NO structured JSON-lines stream yet (C6): prometheus.py emits its one
 * JSON object on stdout and free-form human/log text on stderr. This module
 * pattern-matches those stderr lines into a small {phase,message} event model so
 * the UI can show live progress. It is BEST-EFFORT cosmetics — it NEVER decides
 * a security outcome (that is the gate/verdict layer's job, C5).
 */

export type ProgressPhase =
  | "scan" // nemesis/regex scanning step
  | "verdict" // a nemesis verdict line
  | "dry-run" // [dry-run] preview line
  | "install" // install/copy step
  | "uninstall"
  | "enable"
  | "disable"
  | "step" // generic numbered/bulleted step
  | "warn"
  | "error"
  | "info"; // anything else

export interface ProgressEvent {
  phase: ProgressPhase;
  message: string;
  /** when the line is a verdict, the parsed tier (allow|warn|block|error). */
  verdict?: "allow" | "warn" | "block" | "error";
  /** the raw stderr line, untouched. */
  raw: string;
}

const VERDICT_RE = /\b(allow|warn|block|error|safe|dangerous|blocked)\b/i;

function classifyVerdictWord(line: string): ProgressEvent["verdict"] | undefined {
  const m = line.match(VERDICT_RE);
  if (!m) return undefined;
  switch (m[1]?.toLowerCase()) {
    case "allow":
    case "safe":
      return "allow";
    case "warn":
      return "warn";
    case "block":
    case "blocked":
    case "dangerous":
      return "block";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

/**
 * Parse a single stderr line into a ProgressEvent. Returns undefined for blank
 * lines so callers can drop them.
 */
export function parseProgressLine(rawLine: string): ProgressEvent | undefined {
  const raw = rawLine.replace(/\r$/, "");
  const line = raw.trim();
  if (!line) return undefined;

  const lower = line.toLowerCase();

  // [dry-run] markers
  if (/\[dry[- ]?run\]/i.test(line)) {
    return { phase: "dry-run", message: line, raw };
  }

  // nemesis verdict lines (e.g. "nemesis verdict: BLOCK", "VERDICT allow")
  if (/\bverdict\b/i.test(line) || /\bnemesis\b/i.test(line)) {
    const verdict = classifyVerdictWord(line);
    return { phase: "verdict", message: line, verdict, raw };
  }

  // explicit error/warn prefixes
  if (/^(error|err|fatal|!|✗|×)\b/i.test(line) || lower.startsWith("error:")) {
    return { phase: "error", message: line, raw };
  }
  if (/^(warn|warning|⚠)\b/i.test(line) || lower.startsWith("warning:")) {
    return { phase: "warn", message: line, raw };
  }

  // action verbs
  if (/\b(scanning|scanned|gating|gate|audit)\b/i.test(lower)) {
    return { phase: "scan", message: line, verdict: classifyVerdictWord(line), raw };
  }
  if (/\b(installing|installed|copying|writing|linking)\b/i.test(lower)) {
    return { phase: "install", message: line, raw };
  }
  if (/\b(uninstalling|uninstalled|removing|removed)\b/i.test(lower)) {
    return { phase: "uninstall", message: line, raw };
  }
  if (/\b(enabling|enabled|re-?arm)\b/i.test(lower)) {
    return { phase: "enable", message: line, raw };
  }
  if (/\b(disabling|disabled)\b/i.test(lower)) {
    return { phase: "disable", message: line, raw };
  }

  // numbered / bulleted step lines: "1) ...", "- ...", "==> ...", "[3/7] ..."
  if (/^(\s*(\d+[).]|[-*•]|==>|\[\d+\/\d+\]))\s+/.test(raw)) {
    return { phase: "step", message: line, raw };
  }

  return { phase: "info", message: line, raw };
}

/**
 * Build an onStderr callback that parses each line and forwards non-blank
 * progress events to `emit`. Pass directly as RunOptions.onStderr.
 */
export function makeProgressSink(emit: (e: ProgressEvent) => void): (line: string) => void {
  return (line: string) => {
    const ev = parseProgressLine(line);
    if (ev) emit(ev);
  };
}

/** Parse a whole stderr blob into the ordered list of progress events. */
export function parseProgress(stderr: string): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  for (const line of stderr.split("\n")) {
    const ev = parseProgressLine(line);
    if (ev) out.push(ev);
  }
  return out;
}
