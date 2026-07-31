/**
 * kernel-host.test.ts — node:test for the MAIN kernel session host (APP-045).
 * A fake KernelSidecar stands in for engine-bridge's spawnKernelSidecar so the host's
 * session bookkeeping, event forwarding, and no-orphan teardown are tested with no python.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { KernelEvent, KernelSidecar } from "@prometheus/engine-bridge";

import { KernelHost } from "./kernel-host.js";

interface FakeSidecar extends KernelSidecar {
  fire(e: KernelEvent): void;
  calls: string[];
  disposed: boolean;
}

function makeFake(): { spawner: () => FakeSidecar; last(): FakeSidecar } {
  let last: FakeSidecar;
  const spawner = (): FakeSidecar => {
    const listeners = new Set<(e: KernelEvent) => void>();
    const s: FakeSidecar = {
      pid: 1234,
      exited: Promise.resolve(0),
      calls: [],
      disposed: false,
      on(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      send() {},
      execute(id, code) {
        s.calls.push(`execute:${id}:${code}`);
      },
      interrupt() {
        s.calls.push("interrupt");
      },
      restart() {
        s.calls.push("restart");
      },
      vars() {},
      inspect() {},
      dataframe(name, offset, limit) {
        s.calls.push(`dataframe:${name}:${offset}:${limit}`);
      },
      dispose() {
        s.disposed = true;
      },
      fire(e) {
        for (const l of listeners) l(e);
      },
    };
    last = s;
    return s;
  };
  return { spawner, last: () => last };
}

test("start returns a sessionId and forwards events tagged with it", () => {
  const { spawner, last } = makeFake();
  const host = new KernelHost(spawner);
  const seen: { sessionId: string; event: KernelEvent }[] = [];
  host.on("event", (e) => seen.push(e as { sessionId: string; event: KernelEvent }));
  const id = host.start("/ws");
  assert.match(id, /^nb-/);
  last().fire({ event: "ready" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.sessionId, id);
  assert.equal(seen[0]!.event.event, "ready");
});

test("execute/interrupt/restart route to the right session; unknown id → false", () => {
  const { spawner, last } = makeFake();
  const host = new KernelHost(spawner);
  const id = host.start("/ws");
  assert.equal(host.execute(id, "c1", "print(1)"), true);
  assert.equal(host.interrupt(id), true);
  assert.equal(host.restart(id), true);
  assert.deepEqual(last().calls, ["execute:c1:print(1)", "interrupt", "restart"]);
  assert.equal(host.execute("nope", "c1", "x"), false);
  assert.equal(host.interrupt("nope"), false);
});

test("dataframe routes to the right session; unknown id → false (APP-088)", () => {
  const { spawner, last } = makeFake();
  const host = new KernelHost(spawner);
  const id = host.start("/ws");
  assert.equal(host.dataframe(id, "df", 100, 50), true);
  assert.deepEqual(last().calls, ["dataframe:df:100:50"]);
  assert.equal(host.dataframe("nope", "df", 0, 100), false);
});

test("start forces MPLBACKEND=Agg in the kernel env (APP-088)", () => {
  let seenEnv: Record<string, string> | undefined;
  const host = new KernelHost((opts) => {
    seenEnv = opts.env;
    const listeners = new Set<(e: KernelEvent) => void>();
    const s: FakeSidecar = {
      pid: 1,
      exited: Promise.resolve(0),
      calls: [],
      disposed: false,
      on(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      send() {},
      execute() {},
      interrupt() {},
      restart() {},
      vars() {},
      inspect() {},
      dataframe() {},
      dispose() {},
      fire(e) {
        for (const l of listeners) l(e);
      },
    };
    return s;
  });
  host.start("/ws", { EXISTING: "1" });
  assert.equal(seenEnv?.MPLBACKEND, "Agg");
  assert.equal(seenEnv?.EXISTING, "1"); // caller env preserved
});

test("shutdown disposes the session and is idempotent", () => {
  const { spawner, last } = makeFake();
  const host = new KernelHost(spawner);
  const id = host.start("/ws");
  const s = last();
  assert.equal(host.shutdown(id), true);
  assert.equal(s.disposed, true);
  assert.equal(host.has(id), false);
  assert.equal(host.shutdown(id), false); // already gone
});

test("an exit event drops the session so a later shutdown is a no-op", () => {
  const { spawner, last } = makeFake();
  const host = new KernelHost(spawner);
  const id = host.start("/ws");
  last().fire({ event: "exit", code: 0 });
  assert.equal(host.has(id), false);
});

test("disposeAll reaps every live session (no orphan)", () => {
  const { spawner } = makeFake();
  const disposed: boolean[] = [];
  const host = new KernelHost(() => {
    const s = spawner();
    const origDispose = s.dispose;
    s.dispose = () => {
      origDispose();
      disposed.push(true);
    };
    return s;
  });
  host.start("/a");
  host.start("/b");
  host.disposeAll();
  assert.equal(disposed.length, 2);
  assert.equal(host.has("nb-1"), false);
});
