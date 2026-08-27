/**
 * safe-env.test.ts — the curated child environment, including caller-supplied overrides.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { safeChildEnv } from "./safe-env.js";

test("caller-supplied overrides go through the SAME denylist as the inherited env", () => {
  /**
   * `extra` was applied last with no filtering, which re-admitted exactly what the strip loop had
   * just removed. That matters because one caller's `extra` is not trusted: the desktop's
   * `ide:kernel.start` passes the RENDERER's env straight through
   * (ide-ipc → kernelHost.start → spawnKernelSidecar → `safeChildEnv(opts.env)`), and the
   * renderer is the process these guards exist to survive. A compromised renderer could set
   * LD_PRELOAD or PYTHONSTARTUP on a long-lived python3 that MAIN spawns and load its own native
   * code into it.
   */
  const env = safeChildEnv({
    LD_PRELOAD: "/tmp/evil.so",
    LD_LIBRARY_PATH: "/tmp",
    LD_AUDIT: "/tmp/audit.so",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    DYLD_LIBRARY_PATH: "/tmp",
    PYTHONPATH: "/tmp/evil",
    PYTHONSTARTUP: "/tmp/evil.py",
    PYTHONHOME: "/tmp",
  });
  for (const k of [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONHOME",
  ]) {
    assert.equal(env[k], undefined, `${k} survived into the child environment`);
  }
});

test("a legitimate override is still applied — this is a filter, not a ban", () => {
  // Every in-repo use of `extra` sets one of these; the fix must not break them.
  const env = safeChildEnv({ MPLBACKEND: "Agg", PYTHONUNBUFFERED: "1", MY_APP_FLAG: "x" });
  assert.equal(env.MPLBACKEND, "Agg");
  assert.equal(env.PYTHONUNBUFFERED, "1");
  assert.equal(env.MY_APP_FLAG, "x");
});

test("the inherited environment is still stripped, and ordinary vars survive", () => {
  const realPreload = process.env.LD_PRELOAD;
  const realPath = process.env.PATH;
  process.env.LD_PRELOAD = "/tmp/inherited.so";
  try {
    const env = safeChildEnv();
    assert.equal(env.LD_PRELOAD, undefined, "an inherited hijack var survived");
    assert.equal(env.PATH, realPath, "an ordinary inherited var was dropped");
  } finally {
    if (realPreload === undefined) Reflect.deleteProperty(process.env, "LD_PRELOAD");
    else process.env.LD_PRELOAD = realPreload;
  }
});
