/**
 * fleet/heartbeat.ts — cross-terminal presence for the fleet bar.
 *
 * Every interactive Prometheus rewrites ONE file, `<home>/run/<pid>.json`, every couple of
 * seconds. Readers `readdir` that directory. That is the whole protocol.
 *
 * ## Why files and not a socket
 *
 * The alternative was a broker: first instance elects itself, peers push state to it. It gives
 * live push instead of polling, and it is the wrong trade here. A broker has to be elected, has
 * to survive its own death, and — the disqualifying part — a HUNG broker is indistinguishable
 * from an empty fleet. This bar exists to tell you when something is wrong; a transport whose
 * failure mode is "everything looks fine" cannot carry it.
 *
 * A file per pid has no such state. `kill -9` on any instance leaves its file behind, and the
 * next reader sees a pid that is gone and says `dead 1` — the crash reports itself. Nothing to
 * elect, nothing to restart, and it works identically across tmux panes, iTerm tabs and ssh
 * sessions because the only shared thing it needs is the filesystem.
 *
 * ## `dead` means the process is GONE
 *
 * Three facts get folded into one state word, and the folding is deliberate:
 *
 *   - the pid is not alive                     → dead. It crashed or was killed.
 *   - alive, but silent for over 30s           → dead. See below.
 *   - alive, silent for 6–30s                  → its LAST state, flagged `stale`.
 *
 * The 30s rule is the pid-reuse guard. A recycled pid belongs to some unrelated program that is
 * not writing our file, so "alive but the file stopped moving" is the only signal that separates
 * it from a real peer — and it doubles as the answer for a session wedged in a synchronous call.
 * Under 30s we keep the last state instead, because a session blocked for eight seconds on a slow
 * `git status` is not dead and must not be reported as such.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { prometheusHome } from "../home.js";

/** What a peer is doing. `dead` is never self-reported — it is a reader's verdict. */
export type PeerState = "working" | "idle" | "needs-you";
export type FleetState = PeerState | "dead";

/** The record an instance writes about itself. */
export interface Heartbeat {
  pid: number;
  /** the session id, so a peer row can be tied back to `/recall` history. */
  id: string;
  /** ISO — when this instance started (drives the `for` column in `/fleet`). */
  startedAt: string;
  /** ISO — the last time this file was rewritten. Staleness is measured from here. */
  updatedAt: string;
  cwd: string;
  /** the active model id, "" when none is bound yet. */
  model: string;
  state: PeerState;
  /** $TERM_PROGRAM / tmux pane, purely to help a human find the window. */
  term?: string;
}

/** A peer as a READER sees it: the record plus the verdicts only a reader can make. */
export interface FleetPeer extends Omit<Heartbeat, "state"> {
  state: FleetState;
  /** this process's own row. */
  self: boolean;
  /** ms since `updatedAt`. */
  ageMs: number;
  /** alive, but the heartbeat has not moved for over `STALE_MS`. */
  stale: boolean;
}

/** How long a heartbeat may sit still before a live peer is flagged `stale`. */
export const STALE_MS = 6_000;
/** …and past this, a live pid is treated as `dead` (pid reuse, or a wedged session). */
export const STALE_DEAD_MS = 30_000;
/** How long a dead peer's file is kept so the user actually gets to SEE the `dead` chip. */
export const DEAD_KEEP_MS = 5 * 60_000;
/** The heartbeat write interval. Three ticks of silence ⇒ `stale`. */
export const TICK_MS = 2_000;

/** `<home>/run` — where the per-pid files live. */
export function runDir(home: string = prometheusHome()): string {
  return join(home, "run");
}

/** `<home>/run/<pid>.json`. */
export function heartbeatPath(pid: number, home: string = prometheusHome()): string {
  return join(runDir(home), `${pid}.json`);
}

/**
 * Write this instance's heartbeat. Fail-soft — a read-only home means no fleet bar, never a
 * crashed session.
 *
 * Written via a temp file + rename so a reader can never catch a half-written record. The
 * reader tolerates malformed JSON anyway, but a torn file would make a healthy peer flicker
 * out of the bar once every few seconds, which reads as instability that is not there.
 */
export function writeHeartbeat(hb: Heartbeat, home: string = prometheusHome()): boolean {
  const dir = runDir(home);
  const final = join(dir, `${hb.pid}.json`);
  const tmp = `${final}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(hb)}\n`, "utf8");
    // rename over the target: atomic on every POSIX filesystem we run on.
    renameSync(tmp, final);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the temp file is not worth a second failure */
    }
    return false;
  }
}

/** Remove this instance's heartbeat (clean exit). Fail-soft. */
export function clearHeartbeat(pid: number, home: string = prometheusHome()): void {
  try {
    rmSync(heartbeatPath(pid, home), { force: true });
  } catch {
    /* a leftover file is read as `dead`, which is a survivable wrong answer */
  }
}

/** Is `pid` a live process? Signal 0 tests existence without delivering anything. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = it exists and belongs to another user. Alive, just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parse(raw: string): Heartbeat | null {
  try {
    const v = JSON.parse(raw) as Partial<Heartbeat>;
    if (typeof v.pid !== "number" || !Number.isInteger(v.pid) || v.pid <= 0) return null;
    if (v.state !== "working" && v.state !== "idle" && v.state !== "needs-you") return null;
    return {
      pid: v.pid,
      id: typeof v.id === "string" ? v.id : "",
      startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
      cwd: typeof v.cwd === "string" ? v.cwd : "",
      model: typeof v.model === "string" ? v.model : "",
      state: v.state,
      ...(typeof v.term === "string" ? { term: v.term } : {}),
    };
  } catch {
    return null;
  }
}

export interface ReadFleetOptions {
  home?: string;
  /** injected in tests; defaults to `Date.now()`. */
  now?: number;
  /** this process's pid, so its own row can be marked `self`. */
  self?: number;
  /** injected in tests; defaults to `pidAlive`. */
  isAlive?: (pid: number) => boolean;
  /** delete files for peers dead longer than `DEAD_KEEP_MS` (default true). */
  sweep?: boolean;
}

/**
 * Read every peer, newest-first by start time, with liveness resolved.
 *
 * Fail-soft at every level: a missing `run/` is an empty fleet, an unreadable or malformed file
 * is skipped rather than fatal. A fleet bar that throws would take the whole TUI frame with it.
 */
export function readFleet(opts: ReadFleetOptions = {}): FleetPeer[] {
  const home = opts.home ?? prometheusHome();
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? pidAlive;
  const dir = runDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const peers: FleetPeer[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // skips our own *.tmp files
    const path = join(dir, name);
    let hb: Heartbeat | null = null;
    try {
      hb = parse(readFileSync(path, "utf8"));
    } catch {
      hb = null;
    }
    if (!hb) {
      // Garbage, or a file torn by a writer we raced. Sweep only if it is also OLD, so a
      // live peer's file is never deleted out from under it.
      if (opts.sweep !== false) sweepIfOld(path, now, DEAD_KEEP_MS);
      continue;
    }
    const beat = Date.parse(hb.updatedAt);
    const ageMs = Number.isFinite(beat) ? Math.max(0, now - beat) : Number.POSITIVE_INFINITY;
    const alive = isAlive(hb.pid);
    const dead = !alive || ageMs > STALE_DEAD_MS;
    if (dead && ageMs > DEAD_KEEP_MS) {
      // Sweep on the RECORD's own age, not on the file's mtime. The record is what every other
      // decision here is made from, and mixing the two clocks means a peer can vanish from the
      // list while its file stays on disk forever — the list and the directory disagreeing about
      // who exists, which is the one thing a presence store must never do.
      if (opts.sweep !== false) {
        try {
          rmSync(path, { force: true });
        } catch {
          /* another window swept it, or this home is read-only */
        }
      }
      continue;
    }
    peers.push({
      ...hb,
      state: dead ? "dead" : hb.state,
      self: opts.self !== undefined && opts.self === hb.pid,
      ageMs,
      stale: !dead && ageMs > STALE_MS,
    });
  }
  return peers.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}

/**
 * A file with no readable record at all — swept on its MTIME, because there is no `updatedAt`
 * to reason about. Only used for garbage; every real record is aged by its own timestamp above.
 */
function sweepIfOld(path: string, now: number, keepMs: number): void {
  try {
    if (now - statSync(path).mtimeMs > keepMs) rmSync(path, { force: true });
  } catch {
    /* someone else swept it, or we cannot write here */
  }
}

/** The four counts the bar renders. */
export interface FleetCounts {
  working: number;
  idle: number;
  needsYou: number;
  dead: number;
  /** every peer, including this one and the dead ones. */
  total: number;
}

/** Tally peers by state. */
export function fleetCounts(peers: readonly FleetPeer[]): FleetCounts {
  const c: FleetCounts = { working: 0, idle: 0, needsYou: 0, dead: 0, total: peers.length };
  for (const p of peers) {
    if (p.state === "working") c.working += 1;
    else if (p.state === "idle") c.idle += 1;
    else if (p.state === "needs-you") c.needsYou += 1;
    else c.dead += 1;
  }
  return c;
}

/** The live pids of the fleet — what the resource probe attributes usage to. */
export function fleetPids(peers: readonly FleetPeer[]): number[] {
  return peers.filter((p) => p.state !== "dead").map((p) => p.pid);
}
