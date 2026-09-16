import assert from "node:assert/strict";
import test from "node:test";

import type { PidLockFs } from "./pid-lock.js";
import { acquireRunnerStartLock, releaseRunnerStartLock } from "./start-lock.js";

/** Same in-memory fake as pid-lock.test.ts: honours `{flag:"wx"}` exclusivity. */
function fakeFs(files: Record<string, string> = {}): PidLockFs {
  return {
    writeFileSync: (p, data, opts) => {
      if (opts.flag === "wx" && p in files) {
        const err = new Error("EEXIST") as NodeJS.ErrnoException;
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

test("acquireRunnerStartLock: a free lock is claimed", () => {
  const fs = fakeFs();
  assert.equal(acquireRunnerStartLock("ollama", fs), true);
});

test("acquireRunnerStartLock: two DIFFERENT runner ids never contend for the same lock file", () => {
  const files: Record<string, string> = {};
  const fs = fakeFs(files);
  assert.equal(acquireRunnerStartLock("ollama", fs), true);
  assert.equal(acquireRunnerStartLock("lmstudio", fs), true, "a different runner must get its own lock");
  assert.equal(Object.keys(files).length, 2);
});

test("acquireRunnerStartLock then releaseRunnerStartLock: a second attempt for the SAME runner succeeds once released", () => {
  const fs = fakeFs();
  assert.equal(acquireRunnerStartLock("ollama", fs), true);
  releaseRunnerStartLock("ollama", fs);
  assert.equal(acquireRunnerStartLock("ollama", fs), true);
});

test("acquireRunnerStartLock: refuses a second attempt for the SAME runner while the holder is still alive", () => {
  // Both calls run as THIS test process, so the lock's recorded holder pid is genuinely alive —
  // the exact condition acquireLock must refuse to steal, without needing to fake process.kill.
  const fs = fakeFs();
  assert.equal(acquireRunnerStartLock("ollama", fs), true);
  assert.equal(
    acquireRunnerStartLock("ollama", fs),
    false,
    "the first attempt never released — a live holder's lock must not be stolen",
  );
});
