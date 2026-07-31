import assert from "node:assert/strict";
import { dirname, join } from "node:path";
/**
 * kernel-sidecar.test.ts — spawnKernelSidecar tests (APP-044).
 *
 * Uses a fake NDJSON kernel (node stands in for python3, __fixtures__/fake-kernel.mjs)
 * so the bridge's line-buffered event parsing, in-flight fail-close on exit, request
 * writer, and process-tree dispose are all exercised WITHOUT jupyter_client present.
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { type KernelEvent, spawnKernelSidecar } from "./sidecar-runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_KERNEL = join(HERE, "__fixtures__", "fake-kernel.mjs");

/**
 * A recorder: ONE persistent listener for the kernel's lifetime (how a real consumer
 * subscribes) collecting every event, plus a `wait(pred)` that checks already-seen
 * events first, then waits for the next match. This avoids the subscribe/unsubscribe
 * race a per-wait listener would hit when a single stdout chunk carries many events.
 */
function record(k: ReturnType<typeof spawnKernelSidecar>) {
  const all: KernelEvent[] = [];
  const waiters: { pred: (e: KernelEvent) => boolean; resolve: (e: KernelEvent) => void }[] = [];
  k.on((e) => {
    all.push(e);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(e)) {
        waiters.splice(i, 1)[0]!.resolve(e);
      }
    }
  });
  return {
    all,
    wait(pred: (e: KernelEvent) => boolean, ms = 5000): Promise<KernelEvent> {
      const hit = all.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const entry = { pred, resolve };
        waiters.push(entry);
        setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            reject(new Error(`timeout; events: ${all.map((e) => e.event).join(",")}`));
          }
        }, ms);
      });
    },
  };
}

function fakeKernel() {
  const k = spawnKernelSidecar({ pythonBin: process.execPath, scriptPath: FAKE_KERNEL });
  return { k, rec: record(k) };
}

test("emits ready on spawn, then execute streams + done{ok}", async () => {
  const { k, rec } = fakeKernel();
  try {
    await rec.wait((e) => e.event === "ready");
    k.execute("c1", "print(1)");
    const s = await rec.wait((e) => e.event === "stream" && e.id === "c1");
    assert.equal(s.text, "print(1)");
    const d = await rec.wait((e) => e.event === "done" && e.id === "c1");
    assert.equal(d.status, "ok");
  } finally {
    k.dispose();
    await k.exited;
  }
});

test("non-JSON stdout noise is ignored; the stream still parses", async () => {
  const { k, rec } = fakeKernel();
  try {
    await rec.wait((e) => e.event === "ready");
    k.execute("c2", "NOISE then output");
    const s = await rec.wait((e) => e.event === "stream" && e.id === "c2");
    assert.match(String(s.text), /NOISE/);
    await rec.wait((e) => e.event === "done" && e.id === "c2");
  } finally {
    k.dispose();
    await k.exited;
  }
});

test("FAIL-CLOSED: a cell in flight at process exit gets a synthetic done{error}", async () => {
  const { k, rec } = fakeKernel();
  try {
    await rec.wait((e) => e.event === "ready");
    k.execute("hang1", "HANG forever");
    await rec.wait((e) => e.event === "stream" && e.id === "hang1"); // running, no done
    const done = rec.wait((e) => e.event === "done" && e.id === "hang1");
    k.dispose(); // shutdown → fake exits → in-flight cell must be failed closed
    const d = await done;
    assert.equal(d.status, "error");
  } finally {
    await k.exited;
  }
});

test("dispose() resolves exited and reaps the process", async () => {
  const { k, rec } = fakeKernel();
  await rec.wait((e) => e.event === "ready");
  const pid = k.pid;
  assert.ok(pid && pid > 0);
  k.dispose();
  const code = await k.exited;
  assert.ok(code === 0 || code === null || typeof code === "number");
  // the pid should no longer be alive.
  assert.throws(() => process.kill(pid!, 0));
});

test("restart re-emits ready; vars/inspect round-trip", async () => {
  const { k, rec } = fakeKernel();
  try {
    await rec.wait((e) => e.event === "ready");
    k.restart();
    // wait for a SECOND ready (the fresh kernel).
    await rec.wait(
      (e) => e.event === "ready" && rec.all.filter((x) => x.event === "ready").length >= 2,
    );
    k.vars();
    const v = await rec.wait((e) => e.event === "vars");
    assert.ok(Array.isArray(v.variables));
    k.inspect("x");
    const i = await rec.wait((e) => e.event === "inspect");
    assert.equal(i.found, true);
  } finally {
    k.dispose();
    await k.exited;
  }
});

test("missing script → fatal error event + exited resolves", async () => {
  const k = spawnKernelSidecar({
    pythonBin: process.execPath,
    scriptPath: "/nonexistent/kernel.py",
  });
  const rec = record(k);
  const e = await rec.wait((ev) => ev.event === "error");
  assert.equal(e.fatal, true);
  assert.match(String(e.error), /not found/);
  const code = await k.exited;
  assert.equal(code, null);
});
