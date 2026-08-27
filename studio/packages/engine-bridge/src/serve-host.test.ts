/**
 * serve-host.test.ts — the CLI-owned runner supervisor (CLI-022). All process/network
 * seams are faked; the state file is a real tmp file so the persist/round-trip is
 * exercised end-to-end. One test uses a REAL ephemeral port for the conflict path.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type ServeSpec, createServeHost, serveStatePath } from "./serve-host.js";

function tmpState(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "serve-host-"));
  return {
    file: join(dir, "serve-state.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const SPEC: ServeSpec = {
  profileId: "qwen-q4-llamacpp",
  model: "qwen3-8b",
  runner: "llamacpp",
  port: 8080,
  argv: ["llama-server", "-m", "/models/qwen3.gguf", "--port", "8080"],
  baseUrl: "http://127.0.0.1:8080/v1",
};

test("start → status → stop round-trips (fake spawn + tmp state)", async () => {
  const { file, cleanup } = tmpState();
  try {
    let alive = true;
    const kills: [number, string][] = [];
    let unrefs = 0;
    const host = createServeHost({
      stateFile: file,
      spawn: () => ({ pid: 4242, unref: () => unrefs++ }),
      probePort: async () => ({ free: true }),
      isAlive: () => alive,
      portAnswering: async () => alive,
      kill: (pid, sig) => {
        kills.push([pid, sig]);
        if (sig === "SIGTERM") alive = false; // graceful stop
      },
      now: () => 100000,
    });

    const res = await host.start(SPEC);
    assert.ok(res.ok && res.record.pid === 4242);
    assert.equal(unrefs, 1, "child is unref'd so the CLI can exit (daemon mode)");
    // pid recorded to disk BEFORE unref → no silent orphan.
    assert.match(readFileSync(file, "utf8"), /4242/);

    const st1 = await host.status();
    assert.equal(st1.length, 1);
    assert.equal(st1[0]?.profileId, SPEC.profileId);
    assert.ok(st1[0] && st1[0].uptimeSec >= 0);

    const stop = await host.stop(SPEC.profileId);
    assert.deepEqual(stop, { ok: true, found: true, killed: false });
    assert.deepEqual(kills, [[4242, "SIGTERM"]]);

    const st2 = await host.status();
    assert.equal(st2.length, 0, "status is empty after stop");
  } finally {
    cleanup();
  }
});

test("occupied port fails fast, spawns nothing", async () => {
  const { file, cleanup } = tmpState();
  try {
    let spawned = false;
    const host = createServeHost({
      stateFile: file,
      spawn: () => {
        spawned = true;
        return { pid: 1 };
      },
      probePort: async () => ({ free: false, pid: 999 }),
    });
    const res = await host.start(SPEC);
    assert.ok(!res.ok);
    if (!res.ok) {
      assert.match(res.error, /port 8080 in use \(pid 999\)/);
      assert.equal(res.heldByPid, 999);
    }
    assert.equal(spawned, false, "no spawn when the port is occupied");
  } finally {
    cleanup();
  }
});

test("real ephemeral port conflict is detected by the default probe", async () => {
  const { file, cleanup } = tmpState();
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const host = createServeHost({
      stateFile: file,
      spawn: () => ({ pid: 7 }), // must never be reached
    });
    const res = await host.start({ ...SPEC, port });
    assert.ok(!res.ok);
    if (!res.ok) assert.match(res.error, new RegExp(`port ${port} in use`));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cleanup();
  }
});

test("SIGTERM → grace → SIGKILL when the child ignores SIGTERM", async () => {
  const { file, cleanup } = tmpState();
  try {
    const kills: string[] = [];
    let clock = 0;
    const host = createServeHost({
      stateFile: file,
      spawn: () => ({ pid: 5, unref: () => {} }),
      probePort: async () => ({ free: true }),
      isAlive: () => true, // never dies on SIGTERM
      portAnswering: async () => true,
      kill: (_pid, sig) => kills.push(sig),
      sleep: async () => {
        clock += 100;
      },
      now: () => clock,
      graceMs: 300,
    });
    await host.start(SPEC);
    const stop = await host.stop(SPEC.profileId);
    assert.equal(stop.killed, true);
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  } finally {
    cleanup();
  }
});

test("stop of an unrecorded profile is idempotent (found:false, no kill)", async () => {
  const { file, cleanup } = tmpState();
  try {
    let killed = false;
    const host = createServeHost({
      stateFile: file,
      kill: () => {
        killed = true;
      },
    });
    const stop = await host.stop("never-served");
    assert.deepEqual(stop, { ok: true, found: false });
    assert.equal(killed, false);
  } finally {
    cleanup();
  }
});

test("stop self-heals a dead/stale pid without killing anything", async () => {
  const { file, cleanup } = tmpState();
  try {
    writeFileSync(
      file,
      JSON.stringify({
        servers: [
          {
            profileId: "gone",
            model: "m",
            runner: "r",
            port: 8080,
            pid: 123,
            startedAt: "2026-07-17T00:00:00Z",
          },
        ],
      }),
    );
    let killed = false;
    const host = createServeHost({
      stateFile: file,
      isAlive: () => false, // pid already dead
      kill: () => {
        killed = true;
      },
    });
    const stop = await host.stop("gone");
    assert.deepEqual(stop, { ok: true, found: true, wasStale: true });
    assert.equal(killed, false, "never signal a stale pid (PID-reuse hazard)");
    assert.match(readFileSync(file, "utf8"), /"servers": \[\]/);
  } finally {
    cleanup();
  }
});

test("status drops a recorded-but-dead server and prunes the state file", async () => {
  const { file, cleanup } = tmpState();
  try {
    writeFileSync(
      file,
      JSON.stringify({
        servers: [
          {
            profileId: "dead",
            model: "m",
            runner: "r",
            port: 8080,
            pid: 1,
            startedAt: "2026-07-17T00:00:00Z",
          },
        ],
      }),
    );
    const host = createServeHost({
      stateFile: file,
      isAlive: () => false, // pid dead → not live
      portAnswering: async () => true,
    });
    const st = await host.status();
    assert.equal(st.length, 0);
    assert.match(readFileSync(file, "utf8"), /"servers": \[\]/);
  } finally {
    cleanup();
  }
});

test("status treats a live pid whose port is silent as stale", async () => {
  const { file, cleanup } = tmpState();
  try {
    writeFileSync(
      file,
      JSON.stringify({
        servers: [
          {
            profileId: "silent",
            model: "m",
            runner: "r",
            port: 8080,
            pid: 1,
            startedAt: "2026-07-17T00:00:00Z",
          },
        ],
      }),
    );
    const host = createServeHost({
      stateFile: file,
      isAlive: () => true, // pid alive…
      portAnswering: async () => false, // …but the port doesn't answer → stale
    });
    const st = await host.status();
    assert.equal(st.length, 0, "liveness needs BOTH pid alive AND port answering");
  } finally {
    cleanup();
  }
});

test("serveStatePath honors PROMETHEUS_MODELS_DIR", () => {
  const prev = process.env.PROMETHEUS_MODELS_DIR;
  process.env.PROMETHEUS_MODELS_DIR = "/tmp/prom-models-test";
  try {
    assert.equal(serveStatePath(), "/tmp/prom-models-test/serve-state.json");
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "PROMETHEUS_MODELS_DIR");
    else process.env.PROMETHEUS_MODELS_DIR = prev;
  }
});

test("a REAL spawn that cannot launch returns ok:false instead of throwing uncaught", async () => {
  /**
   * `defaultSpawn` returned the child without subscribing to `error`, and an EventEmitter with no
   * `error` listener rethrows as an UNCAUGHT exception. `start()` handles the failure correctly —
   * no pid, so it returns a tidy `{ok:false}` — but the raw ENOENT still surfaced a tick later,
   * past the point any caller could catch it. Every other spawn site in this package attaches the
   * listener; this one did not, and nothing caught it because the production caller injects no
   * spawn seam while every existing test in this file does.
   *
   * The default path is therefore exercised deliberately here — no `spawn` dep — with a command
   * that cannot exist.
   */
  const uncaught: Error[] = [];
  const onUncaught = (err: Error): void => void uncaught.push(err);
  process.on("uncaughtException", onUncaught);
  try {
    const { file, cleanup } = tmpState();
    // NO `spawn` dep — the point is to exercise the DEFAULT path the production caller uses.
    const host = createServeHost({
      stateFile: file,
      probePort: async () => ({ free: true }),
      isAlive: () => false,
      portAnswering: async () => false,
    });
    const res = await host.start({
      ...SPEC,
      argv: ["prometheus-no-such-binary-9f3a2b", "--port", "8080"],
    });
    cleanup();
    assert.equal(res.ok, false, "a spawn that cannot launch must not report success");
    // give the failed child a tick to emit `error`, which is when the old code threw
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.deepEqual(
    uncaught.map((e) => e.message),
    [],
    "the spawn failure escaped as an uncaught exception instead of a returned error",
  );
});
