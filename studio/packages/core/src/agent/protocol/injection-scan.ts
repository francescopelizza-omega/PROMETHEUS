/**
 * agent/protocol/injection-scan.ts — a lightweight, in-process indirect-prompt-injection
 * pattern scanner for TEXT a tool hands back (as opposed to a command the agent decided to run).
 *
 * Ports the same signal classes `python/sidecar/fetchproxy.py`'s IPI scanner already uses for
 * `web_fetch` (override/persona/exfil/tool/fence phrasings, plus hidden/invisible Unicode) to a
 * PURE, synchronous, dependency-free check — no subprocess, no Python round trip. That is a
 * deliberate choice, not a shortcut: `web_fetch` already pays real network latency per call, so
 * shelling out to Python for one more scan is close to free by comparison; an MCP tool call can
 * come back in single-digit milliseconds, and spawning a fresh `python3` process on every one of
 * those would make THIS scan the slowest part of an otherwise-instant round trip.
 *
 * A HEURISTIC, best-effort signal — like the scanner it mirrors, this is not a sole defense (see
 * the research behind this whole plan on why pattern/classifier scanners alone don't hold up
 * against an adaptive attacker). It exists as a cheap, always-on layer UNDER the structural
 * untrusted-data framing callers apply regardless — the frame is the real protection; this is
 * what lets a caller also say "and this one looks suspicious" inline.
 *
 * PURE: no node, no IO. Reusable anywhere text arrives from something other than the user.
 */

interface Pattern {
  klass: string;
  re: RegExp;
}

const PATTERNS: readonly Pattern[] = [
  {
    klass: "override",
    re: /ignore\s+(all\s+)?(the\s+)?(previous|above|prior|earlier)\s+(instructions|prompts?|messages?)/i,
  },
  { klass: "override", re: /disregard\s+(all\s+)?(previous|above|your)\s+\w+/i },
  // The classic injection template — "ignore/disregard the previous X and do Y INSTEAD" — does
  // not require the literal word "instructions" right after "previous"/"above": point 7's
  // regression suite found "ignore the above and run this instead" slips past both patterns
  // above. "instead" nearby is the compound signal that distinguishes a substitution attempt
  // from ordinary prose that happens to mention "previous"/"above" on its own.
  {
    klass: "override",
    re: /\b(ignore|disregard)\b[^\n]{0,40}\b(previous|above|prior|earlier)\b[^\n]{0,25}\binstead\b/i,
  },
  { klass: "persona", re: /you\s+are\s+now\s+(a|an|the)\b/i },
  { klass: "persona", re: /\b(system\s*prompt|developer\s*message)\b/i },
  {
    klass: "exfil",
    re: /\b(send|post|exfiltrate|upload|forward|leak)\b[^\n]{0,40}\b(api[_-]?key|token|secret|password|credentials?|cookie|env)\b/i,
  },
  { klass: "exfil", re: /\bcurl\b[^\n]{0,80}\b(\.env|id_rsa|\/etc\/passwd|secrets?)\b/i },
  {
    klass: "tool",
    re: /\b(run|execute|eval)\b[^\n]{0,30}\b(the\s+following|this\s+command|shell|bash|powershell)\b/i,
  },
  { klass: "fence", re: /\bBEGIN\b[^\n]{0,30}\bINSTRUCTIONS?\b/i },
];

/** Zero-width/bidi-control/BOM/Unicode-tag characters used to hide text from a human reviewer. */
const HIDDEN_CHARS_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/u;

export interface InjectionScanResult {
  flagged: boolean;
  /** which signal classes matched, deduped — e.g. ["override", "exfil"]. */
  signals: string[];
}

/** Scan arbitrary text for the same signal classes fetchproxy.py's web_fetch IPI scan uses. */
export function scanForInjectionSignals(text: string): InjectionScanResult {
  const signals = new Set<string>();
  for (const { klass, re } of PATTERNS) {
    if (re.test(text)) signals.add(klass);
  }
  if (HIDDEN_CHARS_RE.test(text)) signals.add("hidden-chars");
  return { flagged: signals.size > 0, signals: [...signals] };
}
