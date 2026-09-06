/**
 * pid-lock.ts — an exclusive, crash-safe file lock keyed by an OS pid.
 *
 * Extracted from ollama-watchdog-entry.ts's original inline `acquireLock`/`releaseLock` (which
 * used this exact scheme so only one idle-shutdown watchdog ever owns a runner) so a SECOND
 * caller — start-lock.ts's "only one Prometheus surface may be mid-spawn for this runner at a
 * time" — can reuse it instead of a second hand-rolled copy, and so the scheme itself finally
 * gets unit-test coverage (neither caller had any before this file existed).
 *
 * `{ flag: "wx" }` is an atomic exclusive create at the OS level — it fails with `EEXIST` if the
 * file already exists, with no gap between "check" and "create" a rename-based scheme would
 * leave open (a plain rename OVERWRITES an existing target unconditionally on POSIX, so it can
 * never actually detect a rival). A stale lock (the pid it names is dead) is reclaimed by
 * deleting it and retrying once — evidence of a previous holder that crashed or was killed
 * without cleaning up, not a live rival.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The fs surface a lock needs (injectable — a unit test never wants to touch a real path). */
export interface PidLockFs {
  writeFileSync: (path: string, data: string, opts: { flag: string }) => void;
  readFileSync: (path: string) => string;
  unlinkSync: (path: string) => void;
  mkdirSync: (path: string) => void;
}

const defaultFs: PidLockFs = {
  writeFileSync: (p, data, opts) => writeFileSync(p, data, opts),
  readFileSync: (p) => readFileSync(p, "utf8"),
  unlinkSync: (p) => unlinkSync(p),
  mkdirSync: (p) => mkdirSync(p, { recursive: true }),
};

/** True if `pid` names a live process this user can at least see (ESRCH ⇒ dead). Injectable so
 *  a test can simulate a stale lock without needing a real dead pid on the machine. */
export function pidIsAlive(
  pid: number,
  // broadcast-kill-allow: signal is typed as the literal 0 — a liveness probe, never delivered.
  kill: (pid: number, signal: 0) => void = (p, s) => process.kill(p, s),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Try to become the exclusive holder of `path`. Returns false for a live rival; reclaims (and
 * then wins) a stale lock left by a holder that is no longer running. Always pair a `true`
 * result with a later `releaseLock` call, win or lose, from a `finally`.
 */
export function acquireLock(
  path: string,
  fs: PidLockFs = defaultFs,
  pid: number = process.pid,
  isAlive: (pid: number) => boolean = pidIsAlive,
): boolean {
  // The directory create is a CONVENIENCE, and it is not allowed to throw out of here. Every
  // caller is a fail-soft path — the watchdog's own startup lock, `start-lock.ts`, and
  // `eviction-log`'s `withEvictionLock` — where "did not get the lock" is a decision they can
  // act on and an exception is not. EACCES/EROFS/ENOTDIR on `<home>/state` used to propagate
  // straight through `recordEvictionEvent`, aborting a critical-RAM eviction before the kill and
  // silently killing the detached watchdog (spawned `stdio: "ignore"`, so with no trace at all).
  // The `wx` write below is the real test and fails on its own, yielding the honest `false`.
  try {
    fs.mkdirSync(dirname(path));
  } catch {
    /* see above — never fatal here */
  }
  try {
    fs.writeFileSync(path, String(pid), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }

  // A rival file exists and (per the caller) may be stale. Deciding "it's stale" and then
  // acting on that decision (unlink + recreate) must happen as ONE serialized step — an
  // unconditional unlinkSync here, with no re-check, is what let two concurrent racers each
  // read the same stale pid, each decide to reclaim, and stomp on each other's fresh
  // replacement (one racer's unlink deleting the OTHER racer's just-written, live lock,
  // with both then believing they'd won). A companion reclaim-lock — built on this exact
  // same wx primitive, so it recovers from ITS OWN stale/crashed holder too — makes
  // "read + unlink + recreate" one mutually-exclusive critical section per `path` instead of
  // N independent unlinks racing on it.
  const reclaimPath = `${path}.reclaim`;
  if (!acquireLock(reclaimPath, fs, pid, isAlive)) return false; // someone else is reclaiming it right now
  try {
    let held = Number.NaN;
    try {
      held = Number(fs.readFileSync(path).trim());
    } catch {
      /* the rival already released it on its own — path is free, fall through and claim it */
    }
    if (Number.isInteger(held) && held > 0 && isAlive(held)) return false; // a live rival, confirmed
    try {
      fs.unlinkSync(path);
    } catch {
      /* already gone */
    }
    try {
      fs.writeFileSync(path, String(pid), { flag: "wx" });
      return true;
    } catch {
      return false; // claimed by someone else in the same instant — fail safe, never guess
    }
  } finally {
    releaseLock(reclaimPath, fs, pid);
  }
}

/** Release `path`, but only if THIS pid is the one holding it — never blow away a rival's lock. */
export function releaseLock(
  path: string,
  fs: PidLockFs = defaultFs,
  pid: number = process.pid,
): void {
  try {
    if (Number(fs.readFileSync(path).trim()) === pid) fs.unlinkSync(path);
  } catch {
    /* the file may already be gone — nothing to do */
  }
}
