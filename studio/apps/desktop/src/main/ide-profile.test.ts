/**
 * ide-profile.test.ts — the Profiler must not report success for a target that crashed.
 *
 * Its own file because `ide-ipc.test.ts` already mocks `electron`, and node:test refuses a second
 * mock of the same module in one file.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

function makeFakeIpcMain() {
  const handlers = new Map<string, unknown>();
  return {
    handle(channel: string, fn: unknown): void {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
    on(): void {},
    off(): void {},
    once(): void {},
    removeAllListeners(): void {},
    handlerFor(channel: string): ((ev: unknown, arg: unknown) => Promise<unknown>) | undefined {
      return handlers.get(channel) as ((ev: unknown, arg: unknown) => Promise<unknown>) | undefined;
    },
  };
}

/**
 * ONE fake, module-scoped, because `registerIdeIpcHandlers` registers against the `electron`
 * module's `ipcMain` — the mocked one. A second test that built its OWN fake got an empty
 * handler map ("ide:profile.start is not registered"), since the handlers had gone to the first
 * test's fake. node:test also refuses a second `mock.module` of the same specifier in one file.
 */
const fakeIpcMain = makeFakeIpcMain();
mock.module("electron", {
  exports: {
    ipcMain: fakeIpcMain,
    BrowserWindow: class FakeBrowserWindow {},
    session: { fromPartition: () => ({}) },
  },
});

test("ide:profile.start reports the TARGET's own crash instead of a flame graph of nothing", async () => {
  /**
   * A run whose target raises still profiles "successfully" — the sampler ran, it just sampled
   * runpy/import machinery. The sidecar says so (`profile.py` sets `runError: "RuntimeError:
   * boom"`) and the mapper dropped it, so the panel showed a normal-looking chart, no error, and
   * `ok:true`. The user believed they had profiled code that never executed.
   *
   * Measured through the real handler and the real sidecar: crash.py → 1195µs of import
   * overhead, `runError` absent before the fix; ok.py → 3506µs, no runError.
   */
  const { registerIdeIpcHandlers } = await import("./ide-ipc.js");
  const stub = () => new EventEmitter() as never;
  const dispose = registerIdeIpcHandlers({
    lsp: stub(),
    dap: stub(),
    pty: stub(),
    fsWatch: stub(),
  } as never);

  /**
   * profile.py REFUSES to profile a busy host (`guard_reason()`: 1-minute load average / cores
   * >= 90%), which is deliberate — numbers sampled on a saturated machine are meaningless.
   * The full suite runs one child process per test FILE at CPU-count concurrency, so the load
   * average is high while this test runs and the sidecar honestly returned
   * `{"error":"load","detail":"CPU load 100% >= 90%"}` — no runError, no crash detection, and
   * this assertion failed. Reproduced 4/4 under deliberate saturation and 0/4 idle; with the
   * documented skip hook set it passes at load 22. The PRODUCT is correct; the test was
   * measuring the machine. `PROMETHEUS_PROFILE_SKIP_GUARD` is profile.py's own test hook, and
   * the guard itself is covered by the companion test below rather than merely switched off.
   */
  const priorSkip = process.env.PROMETHEUS_PROFILE_SKIP_GUARD;
  process.env.PROMETHEUS_PROFILE_SKIP_GUARD = "1";
  try {
    const start = fakeIpcMain.handlerFor("ide:profile.start");
    assert.ok(start, "ide:profile.start is not registered");

    const dir = mkdtempSync(join(tmpdir(), "prom-prof-"));
    writeFileSync(join(dir, "crash.py"), 'raise RuntimeError("boom")\n');
    writeFileSync(join(dir, "ok.py"), "for i in range(50000): pass\n");

    const crashed = (await start(
      {},
      {
        path: join(dir, "crash.py"),
        workspaceRoot: dir,
      },
    )) as { ok: boolean; runError?: string };
    assert.equal(crashed.runError, "RuntimeError: boom", "the target's crash was dropped");

    const fine = (await start({}, { path: join(dir, "ok.py"), workspaceRoot: dir })) as {
      ok: boolean;
      runError?: string;
    };
    // self-validating: a healthy run must NOT carry a runError, or the field means nothing.
    assert.equal(fine.ok, true);
    assert.equal(fine.runError, undefined);
  } finally {
    if (priorSkip === undefined) delete process.env.PROMETHEUS_PROFILE_SKIP_GUARD;
    else process.env.PROMETHEUS_PROFILE_SKIP_GUARD = priorSkip;
    dispose();
  }
});

test("ide:profile.start surfaces the sidecar's LOAD REFUSAL rather than an empty flame graph", async () => {
  // The other test disables the busy-host guard so it can measure crash reporting. This one
  // keeps the guard covered: forced on, the refusal must reach the caller as a failure — not as
  // `ok:true` with an empty chart, which is the same "flame graph of nothing" this file exists
  // to prevent.
  const { registerIdeIpcHandlers } = await import("./ide-ipc.js");
  const stub = () => new EventEmitter() as never;
  const dispose = registerIdeIpcHandlers({
    lsp: stub(),
    dap: stub(),
    pty: stub(),
    fsWatch: stub(),
  } as never);
  const priorForce = process.env.PROMETHEUS_PROFILE_FORCE_LOAD;
  process.env.PROMETHEUS_PROFILE_FORCE_LOAD = "1";
  try {
    const start = fakeIpcMain.handlerFor("ide:profile.start");
    assert.ok(start, "ide:profile.start is not registered");
    const dir = mkdtempSync(join(tmpdir(), "prom-prof-load-"));
    writeFileSync(join(dir, "ok.py"), "for i in range(1000): pass\n");
    const out = (await start({}, { path: join(dir, "ok.py"), workspaceRoot: dir })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(out.ok, false, "a load refusal must not be reported as a successful profile");
    assert.ok(out.error, "the refusal must carry a reason the panel can show");
  } finally {
    if (priorForce === undefined) delete process.env.PROMETHEUS_PROFILE_FORCE_LOAD;
    else process.env.PROMETHEUS_PROFILE_FORCE_LOAD = priorForce;
    dispose();
  }
});
