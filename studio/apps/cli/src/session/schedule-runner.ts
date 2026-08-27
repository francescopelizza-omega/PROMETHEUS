/**
 * session/schedule-runner.ts — the pass that actually EXECUTES scheduled/autonomous tasks.
 *
 * Given the current on-disk `ScheduleStore` (session/schedule-store.ts), find every task that
 * is due right now (core's `agent.isDue`) and run each one as a real headless agent turn via
 * `runOneShot` (session/one-shot.ts) — at EXACTLY the autonomy level the task declares, never
 * more, no matter what the run's own profile/tuning would otherwise permit.
 *
 * `ScheduledTask.autonomy` maps onto `one-shot.ts`'s existing, already-safety-reviewed ladder
 * (`headlessAuthLevel`) rather than a second mechanism: "readonly" issues no escalation flags,
 * "edits" sets `--allow-writes`, "commands" sets `--allow-commands`. There is deliberately no
 * fourth level here — a scheduled task never reaches `installs`/`runall` either.
 *
 * ONE task's crash must never abort the pass: a throwing `runOneShot` is caught and recorded as
 * an ordinary `{ok:false}` result, and every task's outcome is persisted immediately after it
 * runs (not batched at the end), so a later crash cannot erase an earlier task's already-recorded
 * result.
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { agent } from "@prometheus/core";

import { prometheusHome } from "../home.js";
import type { ParsedArgs } from "../parse.js";
import { type OneShotResult, runOneShot as defaultRunOneShot } from "./one-shot.js";
import { loadSchedules, upsertTask } from "./schedule-store.js";

/**
 * A lock older than this is treated as ABANDONED by a crashed process, not as a genuinely
 * in-progress pass — generous enough that no real scheduled task should still be mid-flight,
 * short enough that a crash doesn't wedge every future run-due tick forever.
 */
const LOCK_STALE_MS = 15 * 60 * 1000;

function lockPath(home: string): string {
  return join(home, "state", "schedule-run.lock");
}

function tryCreateLockFile(path: string): boolean {
  try {
    writeFileSync(path, `${process.pid}\n${new Date().toISOString()}\n`, { flag: "wx" });
    return true;
  } catch {
    return false; // EEXIST (or any other failure) — someone else already holds it.
  }
}

/**
 * Claim the whole-pass lock. Returns `true` if claimed (the caller MUST release it), `false`
 * if another `run-due` pass is genuinely still in progress — the caller should skip this tick
 * entirely rather than race it; a periodic scheduler always gets another chance.
 */
function claimLock(home: string): boolean {
  const path = lockPath(home);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return false; // an unwritable home is a reason to skip this pass, not to crash it.
  }
  if (tryCreateLockFile(path)) return true;
  try {
    if (Date.now() - statSync(path).mtimeMs <= LOCK_STALE_MS) return false; // genuinely in-progress.
    rmSync(path, { force: true }); // abandoned by a crashed process — reclaim it.
  } catch {
    return false; // couldn't inspect/clear it — safest is to skip, not to double-run.
  }
  return tryCreateLockFile(path);
}

function releaseLock(home: string): void {
  try {
    rmSync(lockPath(home), { force: true });
  } catch {
    /* best-effort — a lock that outlives this process is caught by the staleness check above. */
  }
}

export interface ScheduleRunnerDeps {
  /** injected in tests; defaults to the real studio/apps/cli/src/session/one-shot.ts runOneShot. */
  runOneShot?: typeof import("./one-shot.js").runOneShot;
  /** injected in tests; defaults to Date.now. */
  now?: () => number;
  write?: (line: string) => void;
}

/**
 * Build the synthetic `ParsedArgs` for one scheduled run: every field an inert default except
 * `cwd` (the task's own) and the two things that carry meaning — the autonomy escalation flag,
 * and a `--session-id` so this run gets its own session record instead of colliding with (or
 * silently appending to) any other run's.
 */
function parsedArgsFor(task: agent.ScheduledTask, sessionId: string): ParsedArgs {
  const flags: Record<string, string | true> = { "session-id": sessionId };
  // Exactly the one-shot ladder (`headlessAuthLevel`), never more: "commands" implies edits too
  // (that is one-shot.ts's own rule), so only ONE flag is ever set here, never both.
  if (task.autonomy === "commands") {
    flags["allow-commands"] = true;
  } else if (task.autonomy === "edits") {
    flags["allow-writes"] = true;
  }
  return {
    command: [],
    positionals: [],
    json: false,
    noColor: false,
    help: false,
    version: false,
    repl: false,
    dryRun: false,
    // A scheduled task never forces the effort knob past the capability table: it runs
    // unattended, so a 400 from a forced parameter has nobody to see it or turn it back off.
    forceEffort: false,
    yes: false,
    strict: false,
    force: false,
    noGate: false,
    verbose: false,
    quiet: false,
    cwd: task.cwd,
    flags,
  };
}

/** What a throwing `runOneShot` is treated as — an ordinary, honest failure. */
function failureFromThrow(err: unknown): OneShotResult {
  return {
    ok: false,
    reply: "",
    toolCalls: [],
    capped: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Run every DUE, enabled task once, update its lastRunIso/lastResult, persist, and return what
 * ran.
 *
 * Never throws: one task's crash must not stop the rest of the pass, and must not prevent the
 * store from being saved with whatever DID complete.
 */
export async function runDueSchedules(
  home: string | undefined,
  deps: ScheduleRunnerDeps = {},
): Promise<{ ran: agent.ScheduledTask[]; skipped: number }> {
  const now = deps.now ?? Date.now;
  const runOneShot = deps.runOneShot ?? defaultRunOneShot;
  const resolvedHome = home ?? prometheusHome();

  /**
   * Whole-pass lock. Two overlapping `run-due` invocations (an installed cron tick firing again
   * before the previous pass finished, or a manual invocation racing the installed cron) used to
   * both `loadSchedules` the same on-disk snapshot before either had written back — so BOTH
   * would see a task as "not yet run this tick" and execute it concurrently. For an "edits" or
   * "commands" autonomy task, that means a real duplicate side effect: a double git push, a
   * duplicate paid API call, a duplicate notification. A pass that can't claim the lock skips
   * this tick entirely rather than racing it — a periodic scheduler always gets another chance.
   */
  if (!claimLock(resolvedHome)) {
    deps.write?.("⏭ another scheduled-task pass is already running — skipping this tick");
    return { ran: [], skipped: 0 };
  }
  try {
    const store = loadSchedules(home);
    const ran: agent.ScheduledTask[] = [];
    let skipped = 0;

    for (const task of Object.values(store)) {
      if (!agent.isDue(task, now())) {
        skipped++;
        continue;
      }

      deps.write?.(`▶ running scheduled task "${task.name}"`);

      // Claimed the MOMENT it's picked up as due — before execution, matching
      // `ScheduledTask.lastRunIso`'s own documented contract ("set the moment execution begins,
      // not when it finishes"). Persisted immediately, before the (possibly long-running) turn,
      // rather than only after it resolves.
      upsertTask({ ...task, lastRunIso: new Date(now()).toISOString() }, home);

      const sessionId = `schedule-${task.id}-${now()}`;
      const parsedArgs = parsedArgsFor(task, sessionId);

      let res: OneShotResult;
      try {
        res = await runOneShot(parsedArgs, task.task, { write: deps.write });
      } catch (err) {
        res = failureFromThrow(err);
      }

      const ranIso = new Date(now()).toISOString();
      const fresh: agent.ScheduledTask = {
        ...task,
        lastRunIso: ranIso,
        lastResult: {
          ok: res.ok,
          summary: (res.ok ? res.reply : (res.error ?? "failed")).slice(0, 200),
          ranIso,
          toolCalls: res.toolCalls ?? [],
        },
      };
      // Persisted after EACH task — a later task's crash in this same pass must not lose an
      // earlier task's already-recorded result.
      upsertTask(fresh, home);
      ran.push(fresh);
    }

    return { ran, skipped };
  } finally {
    releaseLock(resolvedHome);
  }
}
