/**
 * health.test.ts — the `prometheus doctor` environment-check registry (CLI-051).
 *
 * Every check is exercised through injected deps — NO real spawn / fs / network — so the table,
 * the per-status marks, the remedy lines, the exit-code aggregation, and the --json shape are all
 * deterministic and offline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CliContext } from "../context.js";
import { type DoctorDeps, buildDoctorChecks, runDoctor } from "../doctor-bridge.js";
import type { ParsedArgs } from "../parse.js";

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    detectEngineVersion: async () => ({
      scriptVersion: "0.15.0",
      raw: "prometheus 0.15.0",
      parts: null,
    }),
    probeCommand: async () => "ok",
    statMode: () => 0o755, // executable
    fetchHead: async () => true, // reachable
    platform: "darwin",
    ptyHelperPaths: ["/fake/node-pty/build/Release/spawn-helper"],
    ollamaHost: "http://127.0.0.1:11434",
    ...over,
  };
}

function ctx(json: boolean): CliContext {
  return {
    client: undefined as unknown as CliContext["client"],
    json,
    args: { positionals: [], flags: {} } as unknown as ParsedArgs,
  };
}

test("doctor: all checks pass → exit 0, --json {ok:true, checks:[...]} (CLI-051)", async () => {
  const out = await runDoctor(ctx(true), deps());
  assert.equal(out.exitCode, 0);
  const env = out.json as { ok: boolean; checks: { id: string; status: string }[] };
  assert.equal(env.ok, true);
  assert.ok(env.checks.every((c) => c.status === "pass"));
  assert.deepEqual(env.checks.map((c) => c.id).sort(), [
    "engine",
    "keychain",
    "network",
    "node-pty",
    "ollama",
  ]);
});

test("doctor: a fail (non-exec spawn-helper) → exit 1 + exactly one remedy line (CLI-051)", async () => {
  const out = await runDoctor(ctx(true), deps({ statMode: () => 0o644 })); // present, NOT executable
  assert.equal(out.exitCode, 1);
  const env = out.json as {
    ok: boolean;
    checks: { id: string; status: string; remedy?: string }[];
  };
  assert.equal(env.ok, false);
  const pty = env.checks.find((c) => c.id === "node-pty");
  assert.equal(pty?.status, "fail");
  assert.match(pty?.remedy ?? "", /chmod \+x/);
});

test("doctor: engine older than MIN_ENGINE → warn showing both versions, still exit 0 (CLI-051)", async () => {
  const out = await runDoctor(
    ctx(true),
    deps({
      detectEngineVersion: async () => ({
        scriptVersion: "0.14.0",
        raw: "prometheus 0.14.0",
        parts: null,
      }),
    }),
  );
  assert.equal(out.exitCode, 0); // a warn never fails the exit
  const engine = (
    out.json as { checks: { id: string; status: string; detail: string }[] }
  ).checks.find((c) => c.id === "engine");
  assert.equal(engine?.status, "warn");
  assert.match(engine?.detail ?? "", /0\.14\.0/);
  assert.match(engine?.detail ?? "", /0\.15\.0/);
});

test("doctor: engine missing → fail with a remedy (CLI-051)", async () => {
  const out = await runDoctor(
    ctx(true),
    deps({ detectEngineVersion: async () => ({ scriptVersion: null, raw: "", parts: null }) }),
  );
  assert.equal(out.exitCode, 1);
  const engine = (
    out.json as { checks: { id: string; status: string; remedy?: string }[] }
  ).checks.find((c) => c.id === "engine");
  assert.equal(engine?.status, "fail");
  assert.ok(engine?.remedy);
});

test("doctor: offline network + ollama down are WARN, not fail (air-gapped passes) (CLI-051)", async () => {
  // fetchHead false = no network / no ollama daemon; probeCommand ok = keychain + ollama-binary present.
  const out = await runDoctor(ctx(true), deps({ fetchHead: async () => false }));
  assert.equal(out.exitCode, 0); // no fails → exit 0 even fully offline (air-gapped passes)
  const env = out.json as { checks: { id: string; status: string }[] };
  assert.equal(env.checks.find((c) => c.id === "network")?.status, "warn");
  assert.equal(env.checks.find((c) => c.id === "ollama")?.status, "warn"); // installed but daemon down
});

test("doctor: per-OS n/a warns (keychain on linux, node-pty on win32) (CLI-051)", async () => {
  const linux = await runDoctor(ctx(true), deps({ platform: "linux" }));
  const kc = (linux.json as { checks: { id: string; status: string }[] }).checks.find(
    (c) => c.id === "keychain",
  );
  assert.equal(kc?.status, "warn"); // keychain n/a off macOS
  const win = await runDoctor(ctx(true), deps({ platform: "win32" }));
  const pty = (win.json as { checks: { id: string; status: string }[] }).checks.find(
    (c) => c.id === "node-pty",
  );
  assert.equal(pty?.status, "warn"); // node-pty n/a on Windows
});

test("doctor: individual checks are stubbable in isolation (CLI-051)", async () => {
  // build the ollama check alone and drive its down-daemon-but-installed branch.
  const checks = buildDoctorChecks(
    deps({ fetchHead: async () => false, probeCommand: async () => "ollama 0.1" }),
  );
  const ollama = checks.find((c) => c.id === "ollama");
  const r = await ollama?.run();
  assert.equal(r?.status, "warn");
  assert.match(r?.remedy ?? "", /ollama serve/);
});

test("doctor: pretty table renders per-check marks + a remedy line (CLI-051)", async () => {
  const out = await runDoctor(ctx(false), deps({ statMode: () => 0o644 }));
  assert.match(out.text ?? "", /CHECK/);
  assert.match(out.text ?? "", /node-pty spawn-helper/);
  assert.match(out.text ?? "", /chmod \+x/); // the remedy line under the fail
});
