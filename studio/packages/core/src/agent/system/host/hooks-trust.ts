/**
 * agent/system/host/hooks-trust.ts — vet a workspace's lifecycle hooks before they may ever run.
 *
 * `.prometheus/settings.json` hooks are user-authored shell commands (`agent/hooks.ts`'s own
 * words) — except a WORKSPACE file is not the user's own input, it travels with the repo. Left
 * unfiltered, a workspace file could introduce brand-new hook commands that ran completely
 * unvetted: SessionStart fires the instant a session opens (unawaited), PostToolUse is
 * fire-and-forget by design — neither had a scan or a human in the loop. SHARED here (not
 * CLI-local) because the Electron desktop app has its own, separate hooks pipeline
 * (`apps/desktop/src/main/agent-hooks.ts`) that reproduces the exact same gap otherwise — one
 * fix, one implementation, both surfaces.
 *
 * The model: a workspace hook that already matches something in the GLOBAL (user-authored,
 * trusted) list by exact {event, command, matcher} is KNOWN. This is deliberately NOT "safe
 * because the string looks familiar" — it is safe because it is a NO-OP relative to what already
 * happens with no workspace file at all: a global hook with no workspace override already runs,
 * unconditionally, in every repo the user opens (hostile or not — that risk is orthogonal to
 * this module and not something scanning a command STRING can ever catch, since the actual
 * danger comes from project-local content the command reads, not the command's own text).
 * Matching on `matcher` too is load-bearing: without it, a workspace could re-declare a trusted
 * command under a WIDER matcher (or none, which matches everything) and silently escalate how
 * often it fires — that would no longer be a no-op, so it is classified NOVEL instead. KNOWN
 * hooks are also re-ordered back to the GLOBAL list's own order (never the workspace's) before
 * being handed anywhere, since PreToolUse hooks are a policy CHAIN (`agent/hooks.ts` stops at
 * the first deny) — a workspace re-listing two already-known hooks in a different order would
 * otherwise be a real escalation (flipping which one wins) hiding behind a "no scan needed"
 * classification, not the no-op it's supposed to be.
 *
 * Anything that is NOT an exact {event,command,matcher} match is NOVEL: it must pass a nemesis
 * scan of its command text AND be confirmed once per workspace (batched into one prompt),
 * before it is ever handed to a HookRunner. The confirmation is cached by a hash of the exact
 * novel set, so a repo that changes its hooks after being trusted re-prompts rather than
 * inheriting the old grant silently (the same "rug pull" concern MCP tool-pinning guards
 * against, applied here too).
 *
 * A global hook the workspace's list does NOT re-select is SUPPRESSED — narrowing down to a
 * subset (including the empty set, `hooks: []`) is the deliberate, safe, "opt out" direction and
 * needs no gate of its own. But bundling a suppression alongside a novel hook the user IS being
 * asked to approve is exactly the moment a sneaky "add one thing, quietly drop a guard" repo
 * would pick, so whenever there's at least one novel hook in play, every suppressed global hook
 * is ALSO surfaced in `refused` (as "suppressed", never "blocked") — the confirmation prompt the
 * user is already looking at is the one place this is guaranteed to be seen.
 *
 * FAIL CLOSED throughout: anything that cannot be scanned, cannot be confirmed, or is declined
 * is dropped from the effective set, never defaulted into it. A `confirm` that throws is treated
 * as a decline, never as a crash that might leave a caller in an undefined state.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type SecurityVerdict, gateCommand, verdictReasons } from "@prometheus/engine-bridge";
import type { HookEvent, HookSpec } from "../../hooks.js";

/** One hook dropped by the scan or the trust gate, and why. */
export interface HookRefusal {
  event: HookEvent;
  command: string;
  reason: string;
}

export interface ResolvedHooks {
  /** the final, vetted, effective set — safe to hand to a HookRunner. */
  hooks: HookSpec[];
  /** hooks dropped along the way, for a startup notice. */
  refused: HookRefusal[];
}

function hooksTrustPath(home: string): string {
  return join(home, "config", "hooks-trust.json");
}

function hooksAuditPath(home: string): string {
  return join(home, "config", "hooks-audit.jsonl");
}

interface TrustRecord {
  cwd: string;
  hash: string;
  grantedAt: string;
}

function readTrustStore(home: string): TrustRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(hooksTrustPath(home), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as TrustRecord[]) : [];
  } catch {
    return []; // absent or unreadable → nothing is trusted yet, the safe default
  }
}

function writeTrustStore(home: string, records: readonly TrustRecord[]): void {
  try {
    const file = hooksTrustPath(home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  } catch {
    /* best effort: worst case, the next session re-prompts */
  }
}

function appendHooksAudit(home: string, entry: Record<string, unknown>): void {
  try {
    const file = hooksAuditPath(home);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    /* best effort, matching appendExecAudit's contract: an audit must never break a session */
  }
}

/**
 * Stable, order-independent hash of a novel-hook set. Each entry is serialized with
 * `JSON.stringify` (which escapes quotes/newlines inside `command`) before the sorted entries
 * are joined with a separator that cannot appear unescaped inside one — a plain
 * `event+command` concatenation would let two DIFFERENT sets collide onto the same hash (e.g.
 * one two-hook set and a differently-split one-hook set can produce the same joined string),
 * which would silently skip the re-prompt a set change is supposed to force.
 */
function hashNovelSet(novel: readonly HookSpec[]): string {
  const sorted = [...novel]
    .map((h) => JSON.stringify([h.event, h.command, h.matcher ?? null]))
    .sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

function isTrusted(home: string, cwd: string, hash: string): boolean {
  return readTrustStore(home).some((r) => r.cwd === cwd && r.hash === hash);
}

function grantTrust(home: string, cwd: string, hash: string): void {
  const records = readTrustStore(home).filter((r) => r.cwd !== cwd);
  records.push({ cwd, hash, grantedAt: new Date().toISOString() });
  writeTrustStore(home, records);
}

/** Same event, command, AND matcher — anything else is a behavior change, not a no-op. */
function sameHook(a: HookSpec, b: HookSpec): boolean {
  return a.event === b.event && a.command === b.command && a.matcher === b.matcher;
}

function dedupeHooks(hooks: readonly HookSpec[]): HookSpec[] {
  const seen = new Set<string>();
  const out: HookSpec[] = [];
  for (const h of hooks) {
    const key = JSON.stringify([h.event, h.command, h.matcher ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Vet the workspace layer against the global one, producing the effective, execution-ready set.
 *
 * `workspaceHooks === undefined` means the workspace file never set the key at all: the global
 * list applies untouched, exactly as before. Once the workspace DOES set the key, its entries
 * split into KNOWN (already one of the user's own global commands — a true no-op, see the module
 * doc comment) and NOVEL (a command, or a wider matcher on an existing command, the workspace
 * itself is introducing); NOVEL entries need a clean nemesis scan and, batched into one prompt, a
 * human's explicit "yes" before they join the effective set. Any global hook the workspace did
 * not re-list is not part of the effective set for this workspace — the same "an explicit list
 * narrows to itself" reading `hooks: []` already relied on, just no longer limited to the
 * all-or-nothing case.
 */
export async function resolveEffectiveHooks(opts: {
  home: string;
  cwd: string;
  globalHooks: readonly HookSpec[];
  workspaceHooks: readonly HookSpec[] | undefined;
  confirm: (prompt: string) => Promise<boolean>;
  gate?: typeof gateCommand;
}): Promise<ResolvedHooks> {
  if (opts.workspaceHooks === undefined) {
    return { hooks: [...opts.globalHooks], refused: [] };
  }
  const deduped = dedupeHooks(opts.workspaceHooks);
  // Iterate GLOBAL, not the workspace's array, so a re-listed subset keeps the user's own
  // established order — see the module doc comment on why order is policy, not decoration.
  const known = opts.globalHooks.filter((g) => deduped.some((w) => sameHook(g, w)));
  const suppressed = opts.globalHooks.filter((g) => !deduped.some((w) => sameHook(g, w)));
  const novel = deduped.filter((w) => !opts.globalHooks.some((g) => sameHook(g, w)));
  const refused: HookRefusal[] = [];
  if (novel.length === 0) {
    return { hooks: known, refused };
  }
  for (const g of suppressed) {
    refused.push({
      event: g.event,
      command: g.command,
      reason:
        "suppressed by this workspace's hooks list (not selected, alongside a new hook this project is requesting)",
    });
    appendHooksAudit(opts.home, {
      cwd: opts.cwd,
      event: g.event,
      command: g.command,
      decision: "suppressed",
    });
  }

  const gate = opts.gate ?? gateCommand;
  const scanned: HookSpec[] = [];
  for (const spec of novel) {
    let verdict: SecurityVerdict;
    try {
      verdict = await gate(spec.command);
    } catch (e) {
      refused.push({
        event: spec.event,
        command: spec.command,
        reason: `scan failed: ${errText(e)}`,
      });
      appendHooksAudit(opts.home, {
        cwd: opts.cwd,
        event: spec.event,
        command: spec.command,
        decision: "blocked",
        reason: "scan-error",
      });
      continue;
    }
    if (verdict.verdict === "block" || verdict.verdict === "error") {
      // A COMMAND gate answers in prose, so `findings[0]` was always undefined here and a
      // refused workspace hook could never name what refused it. There is no rule id to
      // report on that axis — the reason IS the answer.
      const why = verdictReasons(verdict)[0];
      refused.push({
        event: spec.event,
        command: spec.command,
        reason: `nemesis ${verdict.verdict}${why ? `: ${why}` : ""}`,
      });
      appendHooksAudit(opts.home, {
        cwd: opts.cwd,
        event: spec.event,
        command: spec.command,
        decision: "blocked",
        verdict: verdict.verdict,
      });
      continue;
    }
    scanned.push(spec);
  }
  if (scanned.length === 0) {
    return { hooks: known, refused };
  }

  const hash = hashNovelSet(scanned);
  if (isTrusted(opts.home, opts.cwd, hash)) {
    for (const spec of scanned) {
      appendHooksAudit(opts.home, {
        cwd: opts.cwd,
        event: spec.event,
        command: spec.command,
        decision: "auto",
        reason: "previously trusted for this workspace",
      });
    }
    return { hooks: [...known, ...scanned], refused };
  }

  const list = scanned.map((s) => `  ${s.event}: ${s.command}`).join("\n");
  const plural = scanned.length === 1 ? "" : "s";
  const prompt = `This project's .prometheus/settings.json defines ${scanned.length} new lifecycle hook${plural} not in your global config:\n${list}\n\nHooks run automatically as this session works — SessionStart on open, others around every tool call. Trust and run them for this project?`;
  let granted: boolean;
  try {
    granted = await opts.confirm(prompt);
  } catch {
    granted = false; // a confirm seam that throws is a decline, never a silent grant
  }
  for (const spec of scanned) {
    appendHooksAudit(opts.home, {
      cwd: opts.cwd,
      event: spec.event,
      command: spec.command,
      decision: granted ? "approved" : "declined",
    });
  }
  if (!granted) {
    for (const spec of scanned) {
      refused.push({
        event: spec.event,
        command: spec.command,
        reason: "not trusted for this workspace",
      });
    }
    return { hooks: known, refused };
  }
  grantTrust(opts.home, opts.cwd, hash);
  return { hooks: [...known, ...scanned], refused };
}
