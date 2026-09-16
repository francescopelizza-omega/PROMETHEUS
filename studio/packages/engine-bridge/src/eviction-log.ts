/**
 * eviction-log.ts — the shared record of "Prometheus killed one of its OWN child processes to
 * stop the machine from freezing."
 *
 * Written by the two places that actively evict under critical, sustained RAM pressure —
 * ollama-watchdog-entry.ts's poll loop (the raw `ollama serve` daemon) and the desktop's
 * ServeSupervisor (a served llamacpp/vLLM/Ollama recipe, which loads real model weights and is
 * the heaviest of the two). Read by EVERY Prometheus surface (CLI TUI, one-shot CLI, desktop,
 * VS Code) so a kill triggered by ONE surface's watchdog is a visible notice on all of them, not
 * a silent event only the surface that happened to be watching sees.
 *
 * `<home>/state/eviction-events.json` — same path convention as model-activity.json, same
 * atomic temp-file + rename write as fleet/heartbeat.ts, for the same reason: a reader must
 * never catch a half-written record. Capped at MAX_EVENTS so this never grows unbounded; a
 * reader that wants "have I already shown this one" tracks the last `id` it displayed.
 *
 * DELIBERATELY dependency-free of `@prometheus/core` (only `node:*`), same reasoning as
 * ollama-watchdog-entry.ts and start-lock.ts: this is written from a directly `node`-spawned
 * process (the watchdog entry script) that needs its own module graph, not a bundler's.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { acquireLock, releaseLock } from "./pid-lock.js";
import { prometheusHome } from "./prom-home.js";

/** One "Prometheus killed its own child" notice. */
export interface EvictionEvent {
  /** unique per event — a reader tracks the last id it has already shown. */
  id: string;
  /** the runner/recipe id that got stopped, e.g. "ollama", or a served recipe's id. */
  runnerId: string;
  /** a human-readable name for display ("Ollama", a model's label, …). */
  name: string;
  /** the pid that was signalled, when known. */
  pid?: number;
  /** the RAM% reading that triggered this eviction. */
  ramPct: number;
  /** the critical ceiling it was measured against. */
  ceiling: number;
  /** ISO timestamp of the eviction. */
  at: string;
  /** a human-readable explanation, shown verbatim by every surface's notification. */
  reason: string;
}

/** Keep only the most recent handful — this is a live notice feed, not an audit log. Set
 *  comfortably above any realistic single-incident burst (the desktop ServeSupervisor evicting
 *  every currently-ready served recipe at once is the largest such burst in this codebase, and
 *  it is nowhere near this many) so a burst can never crowd out its own still-recent members
 *  before EVICTION_RECENCY_MS's consumers get a chance to read them. */
const MAX_EVENTS = 50;

export function evictionLogPath(home: string = prometheusHome()): string {
  return join(home, "state", "eviction-events.json");
}

/** A short-lived mutex around the read-modify-write below. Built on pid-lock.ts's own
 *  crash-safe primitive (so a holder that dies mid-write doesn't wedge this forever) — without
 *  it, two real concurrent writers (this process's watchdog poll loop and, in a desktop process,
 *  ServeSupervisor's own 30s critical-RAM check) can each read the same array, each append their
 *  own event, and whichever renames second silently discards the other's just-recorded eviction.
 *  Bounded: never blocks longer than `budgetMs` — a write must never be the reason the eviction
 *  itself is delayed, so past the budget this proceeds unlocked (the pre-existing behavior)
 *  rather than risk holding up the caller indefinitely. */
function withEvictionLock<T>(home: string, fn: () => T, budgetMs = 500): T {
  const lockPath = `${evictionLogPath(home)}.lock`;
  const deadline = Date.now() + budgetMs;
  let locked = false;
  for (;;) {
    try {
      locked = acquireLock(lockPath);
    } catch {
      // The lock PATH itself is unusable (EACCES/ENOTDIR on `<home>/state`). Proceed unlocked
      // immediately rather than spending the whole budget busy-waiting on a rival that cannot
      // exist — this runs on the eviction path, under the memory pressure it is reporting.
      break;
    }
    if (locked || Date.now() >= deadline) break; // won it, or gave up waiting
    const spinUntil = Date.now() + 5; // no timers in a synchronous path — a short busy-wait only
    while (Date.now() < spinUntil) {
      /* the critical section this guards is a handful of fs calls — contention clears fast */
    }
  }
  try {
    return fn();
  } finally {
    if (locked) releaseLock(lockPath); // never release a lock we do not hold
  }
}

function isEvictionEvent(v: unknown): v is EvictionEvent {
  const e = v as Partial<EvictionEvent> | null;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.id === "string" &&
    typeof e.runnerId === "string" &&
    typeof e.name === "string" &&
    typeof e.ramPct === "number" &&
    typeof e.ceiling === "number" &&
    typeof e.at === "string" &&
    typeof e.reason === "string"
  );
}

/** Fail-soft: a missing/corrupt log reads as "nothing has ever been evicted", never a throw. */
export function readEvictionEvents(home: string = prometheusHome()): EvictionEvent[] {
  try {
    const raw = JSON.parse(readFileSync(evictionLogPath(home), "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter(isEvictionEvent) : [];
  } catch {
    return [];
  }
}

/**
 * Append one eviction notice (oldest dropped past MAX_EVENTS) and return it with a generated id
 * + timestamp. Fail-soft by design: a write failure here must never be the reason the eviction
 * itself doesn't happen — the caller kills the runaway process regardless of whether this notice
 * landed on disk. Atomic (temp file + rename) so a reader never catches a half-written array.
 */
export function recordEvictionEvent(
  event: Omit<EvictionEvent, "id" | "at">,
  home: string = prometheusHome(),
  now: () => number = Date.now,
): EvictionEvent {
  const full: EvictionEvent = { ...event, id: randomUUID(), at: new Date(now()).toISOString() };
  const final = evictionLogPath(home);
  const tmp = `${final}.${process.pid}.tmp`;
  withEvictionLock(home, () => {
    try {
      const next = [...readEvictionEvents(home), full].slice(-MAX_EVENTS);
      mkdirSync(join(home, "state"), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(next)}\n`, "utf8");
      renameSync(tmp, final);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the temp file is not worth a second failure */
      }
    }
  });
  return full;
}

/** How recently an eviction must have happened to plausibly explain a request that's failing
 *  RIGHT NOW — matches the watchdogs' own sustained-critical check window (2 polls, ~30-60s)
 *  order of magnitude, wide enough to cover one landing moments before or during a request. */
export const EVICTION_RECENCY_MS = 60_000;

/**
 * The most recent eviction for `runnerId`, if any, within `recencyMs` of now. Shared by every
 * surface's request-failure handling (desktop's ai-ipc.ts, the CLI's agent-runtime.ts) so "was
 * this failure caused by an eviction" is answered identically everywhere, instead of three
 * hand-rolled copies of the same date-math drifting apart over time.
 */
export function findRecentEviction(
  runnerId: string | undefined,
  readEvictions: () => EvictionEvent[] = readEvictionEvents,
  recencyMs: number = EVICTION_RECENCY_MS,
): EvictionEvent | undefined {
  if (!runnerId) return undefined;
  // Scan newest-first: recordEvictionEvent appends to the END of the array, so a plain
  // `.find()` here would return the OLDEST qualifying event in the window, not the most recent
  // one this function promises — the wrong incident to explain a failure happening right now.
  const events = readEvictions();
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && ev.runnerId === runnerId && Date.now() - Date.parse(ev.at) < recencyMs) return ev;
  }
  return undefined;
}
