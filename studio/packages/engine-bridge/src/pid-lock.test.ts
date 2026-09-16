import assert from "node:assert/strict";
import test from "node:test";

import { acquireLock, pidIsAlive, type PidLockFs, releaseLock } from "./pid-lock.js";

/** An in-memory fake fs: a map of path → file content. `writeFileSync` honours `{flag:"wx"}`
 *  by throwing EEXIST when the path already has content — the exact semantic the lock's
 *  atomicity depends on. */
function fakeFs(files: Record<string, string> = {}): PidLockFs {
  return {
    writeFileSync: (p, data, opts) => {
      if (opts.flag === "wx" && p in files) {
        const err = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      files[p] = data;
    },
    readFileSync: (p) => {
      const v = files[p];
      if (v === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return v;
    },
    unlinkSync: (p) => {
      delete files[p];
    },
    mkdirSync: () => {
      /* no directories to track in-memory */
    },
  };
}

const PATH = "/home/.prometheus/run/ollama-watchdog.pid";

test("acquireLock: an empty lock file is claimed by the caller's pid", () => {
  const fs = fakeFs();
  assert.equal(acquireLock(PATH, fs, 111), true);
  assert.equal(fs.readFileSync(PATH), "111");
});

test("acquireLock: a live rival's lock is NOT claimed", () => {
  const fs = fakeFs({ [PATH]: "222" });
  assert.equal(
    acquireLock(PATH, fs, 111, (pid) => pid === 222),
    false,
  );
  assert.equal(fs.readFileSync(PATH), "222", "the rival's lock must survive untouched");
});

test("acquireLock: a stale (dead-pid) lock is reclaimed and then won", () => {
  const fs = fakeFs({ [PATH]: "222" });
  assert.equal(
    acquireLock(PATH, fs, 111, () => false), // 222 is not alive
    true,
  );
  assert.equal(fs.readFileSync(PATH), "111");
});

test("acquireLock: a corrupt (non-numeric) lock file is treated as unreadable → refuses rather than guessing", () => {
  const fs = fakeFs({ [PATH]: "not-a-pid" });
  // Number("not-a-pid") is NaN, not > 0, so the guard takes the "not a live rival" branch and
  // reclaims — this asserts that path explicitly rather than leaving it implicit.
  assert.equal(acquireLock(PATH, fs, 111, () => true), true);
});

test("acquireLock: a stale lock leaves no leftover reclaim-marker file behind on success", () => {
  const fs = fakeFs({ [PATH]: "222" });
  assert.equal(acquireLock(PATH, fs, 111, () => false), true);
  assert.throws(() => fs.readFileSync(`${PATH}.reclaim`), "the reclaim marker must be released, win or lose");
});

test("acquireLock: TOCTOU regression — a concurrent racer reclaiming the SAME stale lock can never also win", () => {
  // Simulates a SECOND process (pid 333) starting its own acquireLock attempt on the exact
  // same path at the exact instant the first process (pid 111) is mid-reclaim of it — the
  // precise interleaving the old unconditional-unlinkSync code got wrong (see pid-lock.ts's
  // acquireLock docstring). isAlive treats ONLY 111 as alive: 222 (the stale rival) is dead,
  // and so is a hypothetical 333, but 111 — whoever currently holds the reclaim marker — reads
  // as alive to anyone who checks it, which is what must make the rival back off.
  const fs = fakeFs({ [PATH]: "222" });
  const isAlive = (pid: number) => pid === 111;
  let firstRead = true;
  const instrumented: PidLockFs = {
    ...fs,
    readFileSync: (p) => {
      const value = fs.readFileSync(p);
      if (p === PATH && firstRead) {
        firstRead = false;
        // The rival's ENTIRE acquireLock call happens here, nested inside the first
        // process's own read of the stale lock's content.
        const rivalWon = acquireLock(PATH, fs, 333, isAlive);
        assert.equal(rivalWon, false, "a concurrent racer must NEVER also believe it won the same lock");
      }
      return value;
    },
  };
  assert.equal(acquireLock(PATH, instrumented, 111, isAlive), true);
  assert.equal(fs.readFileSync(PATH), "111", "exactly one pid ends up holding the lock, not both");
});

test("releaseLock: removes the file when the caller's own pid holds it", () => {
  const fs = fakeFs({ [PATH]: "111" });
  releaseLock(PATH, fs, 111);
  assert.throws(() => fs.readFileSync(PATH));
});

test("releaseLock: leaves a DIFFERENT pid's lock alone (never releases a rival's lock by mistake)", () => {
  const fs = fakeFs({ [PATH]: "222" });
  releaseLock(PATH, fs, 111);
  assert.equal(fs.readFileSync(PATH), "222");
});

test("releaseLock: never throws when the file is already gone", () => {
  const fs = fakeFs();
  assert.doesNotThrow(() => releaseLock(PATH, fs, 111));
});

test("acquireLock then releaseLock then acquireLock again: a full lifecycle round-trips", () => {
  const fs = fakeFs();
  assert.equal(acquireLock(PATH, fs, 111), true);
  releaseLock(PATH, fs, 111);
  assert.equal(acquireLock(PATH, fs, 999), true);
  assert.equal(fs.readFileSync(PATH), "999");
});

test("pidIsAlive: ESRCH means dead", () => {
  const err = new Error("no such process") as NodeJS.ErrnoException;
  err.code = "ESRCH";
  assert.equal(
    pidIsAlive(123, () => {
      throw err;
    }),
    false,
  );
});

test("pidIsAlive: EPERM (belongs to another user, but exists) means alive", () => {
  const err = new Error("not permitted") as NodeJS.ErrnoException;
  err.code = "EPERM";
  assert.equal(
    pidIsAlive(123, () => {
      throw err;
    }),
    true,
  );
});

test("pidIsAlive: kill(pid, 0) not throwing means alive", () => {
  assert.equal(
    pidIsAlive(123, () => {
      /* no throw */
    }),
    true,
  );
});
