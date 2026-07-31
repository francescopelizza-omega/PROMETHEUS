/**
 * worker-entry.test.ts — end-to-end: FORK the real worker/index.ts entry and
 * drive it through the WorkerHost over a Node IPC channel (the test stand-in for
 * the Electron utilityProcess channel). Proves the entry binds the transport,
 * routes via runTask, and replies — without electron.
 *
 * The fork target is TypeScript, so we re-use the workspace dev loader
 * (apps/cli/dev-register.mjs) via execArgv so Node type-strips it on the fly.
 */

import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { type WorkerHandle, WorkerHost } from "../main/worker-host.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // …/src/worker
const WORKER_ENTRY = resolve(HERE, "index.ts");
const DEV_REGISTER = resolve(HERE, "..", "..", "..", "cli", "dev-register.mjs");

/** Fork the real worker entry with the TS dev loader; adapt to WorkerHandle. */
function forkRealWorker(): { handle: WorkerHandle; child: ChildProcess } {
  const child = fork(WORKER_ENTRY, [], {
    execArgv: ["--import", DEV_REGISTER],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const handle: WorkerHandle = {
    postMessage: (message: unknown) => child.send(message as object),
    on: ((event: string, listener: (...a: unknown[]) => void) => {
      if (event === "message") child.on("message", (m: unknown) => listener(m));
      else if (event === "exit") child.on("exit", (code: number | null) => listener(code));
      else child.on("error", (e: Error) => listener(e));
    }) as WorkerHandle["on"],
    kill: () => {
      child.kill();
    },
  };
  return { handle, child };
}

test("real worker entry handles a log.aggregate task over a forked channel", async () => {
  let forked: { child: ChildProcess } | undefined;
  const host = new WorkerHost({
    spawn: (): WorkerHandle => {
      forked = forkRealWorker();
      return forked.handle;
    },
    requestTimeoutMs: 15_000,
  });

  try {
    const res = await host.run({
      kind: "log.aggregate",
      payload: { lines: ["installing foo", "nemesis verdict: BLOCK"] },
    });
    assert.equal(res.ok, true);
    assert.equal(res.kind, "log.aggregate");
    if (res.ok && res.kind === "log.aggregate") {
      assert.equal(res.result.total, 2);
      assert.equal(res.result.worstVerdict, "block");
    }
  } finally {
    host.dispose();
    forked?.child.kill();
  }
});
