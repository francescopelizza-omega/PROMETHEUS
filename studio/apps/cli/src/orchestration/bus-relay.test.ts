/**
 * bus-relay.test.ts — LIVE round-trip: the real prom-msg helper (a subprocess) → a real
 * UNIX socket → the relay → the in-RAM MessageBus, including topology resolution.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { orchestration as orch } from "@prometheus/core";

import { startBusRelay } from "./bus-relay.js";
import { installPromMsg } from "./prom-msg.js";
import { makeSpawnCapture } from "./spawn-capture.js";

const tick = () => new Promise((r) => setTimeout(r, 30));

test("LIVE: prom-msg → unix socket → relay → in-RAM bus, with topology resolution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-relay-"));
  // a SHORT socket path (macOS sun_path is 104 chars — the long $TMPDIR would overflow).
  const sock = `/tmp/pm-${process.pid}-${Math.floor(performance.now())}.sock`;
  const bin = installPromMsg(join(dir, "bin"));
  const bus = new orch.MessageBus({ now: () => 0 });
  const relay = startBusRelay({
    bus,
    sockPath: sock,
    resolve: { orchestrator: "lead", parentOf: (n) => (n === "lead" ? undefined : "lead") },
  });
  const spawn = makeSpawnCapture();
  const env = (agent: string) => ({ PROM_BUS_SOCK: sock, PROM_AGENT: agent });

  try {
    // 1. a direct peer message: api → ui
    const r1 = await spawn(bin, {
      args: ["ui", "need the schema"],
      env: env("api"),
      timeoutMs: 8000,
    });
    assert.ok(r1.outcome === "ok" || r1.outcome === "empty", `helper failed: ${r1.stderr}`);
    await tick();
    const m = bus.all().find((x) => x.from === "api" && x.to === "ui");
    assert.ok(m, "peer message reached the in-RAM bus");
    assert.equal(m?.content, "need the schema");
    assert.equal(m?.kind, "msg");

    // 2. content with quotes / $() / a newline survives intact (JSON framing, no shell parse)
    const tricky = 'use "x" and $(boom) now';
    await spawn(bin, { args: ["ui", tricky], env: env("api"), timeoutMs: 8000 });
    await tick();
    assert.ok(
      bus.all().some((x) => x.content === tricky),
      "tricky content preserved verbatim",
    );

    // 3. `done` resolves to a result addressed to the sender's parent (orchestrator)
    await spawn(bin, { args: ["done", "built it"], env: env("api"), timeoutMs: 8000 });
    await tick();
    const res = bus.all().find((x) => x.from === "api" && x.kind === "result");
    assert.equal(res?.to, "lead");

    // 4. identity is from $PROM_AGENT, NOT forgeable via an argument
    await spawn(bin, { args: ["lead", "hi"], env: env("ui"), timeoutMs: 8000 });
    await tick();
    assert.ok(bus.all().some((x) => x.from === "ui" && x.to === "lead"));
  } finally {
    relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relay survives a malformed frame (acks an error, keeps running)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-relay2-"));
  const sock = `/tmp/pm2-${process.pid}-${Math.floor(performance.now())}.sock`;
  const bin = installPromMsg(join(dir, "bin"));
  const bus = new orch.MessageBus({ now: () => 0 });
  const relay = startBusRelay({
    bus,
    sockPath: sock,
    resolve: { orchestrator: "lead", parentOf: () => undefined },
  });
  const spawn = makeSpawnCapture();
  try {
    // a valid message still works after the relay has been up
    await spawn(bin, {
      args: ["lead", "ok"],
      env: { PROM_BUS_SOCK: sock, PROM_AGENT: "api" },
      timeoutMs: 8000,
    });
    await tick();
    assert.ok(bus.all().some((x) => x.from === "api"));
  } finally {
    relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
