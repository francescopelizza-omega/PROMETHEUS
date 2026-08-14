/**
 * session/exec-gate.ts — the nemesis scan + the audit trail for `run_command` (Phase 3).
 *
 * Layer 3 of the five (full_wrapper_compose §6). The other layers reason about STRUCTURE —
 * can we parse it, do we know the programs, what does the ladder say, does the human agree.
 * This one asks the question Prometheus asks about everything else it runs: *does the scanner
 * think this is malicious?* Nothing else in the product executes unscanned, and a command the
 * agent composed should not be the exception.
 *
 * Two things live here because they belong together:
 *
 *  1. **The scan, cached per command text.** The confirm seam wants the verdict so the human
 *     can see it BEFORE answering; the runner needs it because the runner is the last gate
 *     before a spawn. Scanning twice would double a subprocess round-trip on every command,
 *     so the confirm seam's result is latched and the runner consumes it. If the latch is
 *     empty — a host that skipped the confirm, a direct call — the runner scans for itself.
 *     Fail-closed either way: there is no path to a spawn that has not been scanned.
 *
 *  2. **The audit line.** `argvExecuted` is the honest record — what actually ran, post-parse,
 *     not the string the model wrote. It is appended for EVERY outcome, including refusals
 *     and auto-approvals, because "the agent ran this and nobody was asked" is precisely the
 *     event an audit exists to make visible.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { type SecurityVerdict, gateCommand } from "@prometheus/engine-bridge";
import type { ExecTier } from "../../exec/index.js";

/** How a command's fate was decided — the audit's most useful column. */
export type ExecDecision =
  | "auto" // the ladder auto-approved it at this authorization level
  | "approved" // a human said yes
  | "declined" // a human said no
  | "refused" // parse / classify / forbidden-program refusal — never reached a human
  | "blocked" // nemesis BLOCK — refused regardless of level, including A7
  | "proposed"; // an elevated command was PRINTED for the human; Prometheus ran nothing

export interface ExecAuditEntry {
  at: string;
  /** the RE-RENDERED command (what would run), never the model's raw string. */
  command: string;
  tier: ExecTier | "-";
  verdict: SecurityVerdict["verdict"] | "-";
  decision: ExecDecision;
  authLevel: number;
  exitCode?: number;
  /** post-parse argv, one array per stage — the reproducible record. */
  argv?: string[][];
  reason?: string;
}

/* ── the scan, latched ───────────────────────────────────────────────────────*/

interface CachedVerdict {
  text: string;
  verdict: SecurityVerdict;
  at: number;
}

let cached: CachedVerdict | null = null;

/** How long a scan stays good for. Long enough to cross confirm→run, short enough to be a handoff. */
const CACHE_TTL_MS = 60_000;

/**
 * Scan a command line, reusing the confirm seam's result when it is the SAME text.
 *
 * Keyed on the exact rendered text, so a different command never inherits another's verdict —
 * that would be the one cache bug worth genuinely fearing here.
 */
export async function scanCommand(
  commandText: string,
  deps: { gate?: typeof gateCommand } = {},
): Promise<SecurityVerdict> {
  const now = Date.now();
  if (cached && cached.text === commandText && now - cached.at < CACHE_TTL_MS) {
    return cached.verdict;
  }
  const verdict = await (deps.gate ?? gateCommand)(commandText);
  cached = { text: commandText, verdict, at: now };
  return verdict;
}

/** Drop the latch (a new turn, a test). */
export function resetScanCache(): void {
  cached = null;
}

/**
 * Does this verdict stop the command?
 *
 * `block` and `error` both do, and `error` is the important one: it is what a missing binary,
 * a timeout or an unparseable verdict resolves to, so "we could not get a trustworthy answer"
 * behaves exactly like "the answer was no". A0–A7 has no say here — the ladder governs how
 * often a human is ASKED, never whether the scanner is obeyed, and A7's own description says
 * so: *"Nemesis still hard-stops danger."*
 */
export function verdictBlocks(v: SecurityVerdict, gateMode: "enforce" | "warn" | "off"): boolean {
  if (gateMode === "off") return false;
  if (v.verdict === "block") return true;
  return v.verdict === "error" && gateMode === "enforce";
}

/* ── the audit trail ─────────────────────────────────────────────────────────*/

/**
 * Where command executions are recorded.
 *
 * A SEPARATE file from `~/.nemesis/gate-audit.jsonl`, deliberately. That one is the ENGINE's
 * append-only log, written by nemesis and prometheus.py and read back by
 * `security.trust({op:"auditLog"})` — having a TypeScript host write into another component's
 * store would make both sides' invariants everyone's problem. Same JSONL shape, same
 * newest-last discipline, its own file.
 */
export function execAuditPath(home: string): string {
  return join(home, "config", "exec-audit.jsonl");
}

/**
 * Append one line. Never throws — an audit that can break the turn it is auditing would get
 * removed the first time a full disk stopped someone working, and then there would be no
 * audit at all.
 */
export function appendExecAudit(home: string, entry: ExecAuditEntry): void {
  try {
    const file = execAuditPath(home);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

/** Build an entry — one place, so every call site records the same columns. */
export function execAuditEntry(fields: Omit<ExecAuditEntry, "at">): ExecAuditEntry {
  return { at: new Date().toISOString(), ...fields };
}
