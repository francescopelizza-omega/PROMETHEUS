import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * env.test.ts — the typed env client (file 04 §2/§8) against the surfaces that
 * matter:
 *   1) CONTRACT (REAL envmgr.py): listEnvs() returns a typed Env[] and marks
 *      EXACTLY ONE env active (the deterministic fallback = the system env,
 *      always present). Skips gracefully if python3/the sidecar is absent.
 *   2) CONTRACT (REAL envmgr.py): cudaInfo() returns a well-formed GpuInfo —
 *      hasNvidia:false on this Apple-silicon mac, gpus is an array, the boolean
 *      flags are booleans.
 *   3) FAIL-CLOSED TYPED SHAPE: a nemesis-BLOCK install is a RETURNED value, not a
 *      throw. Against a fake sidecar that emits the §8 blocked envelope, pkgInstall
 *      resolves to {ok:false, blocked:true, gate:{verdict:'block',…}} with the gate
 *      verdict camelCased and riding through — JS never decides "safe" (C5).
 */
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createEnvClient } from "./env.js";
import type { Env, GpuInfo } from "./env.types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// the REAL studio/python/sidecar dir (…/engine-bridge/src -> up 3 = studio).
const REAL_SIDECAR_DIR = join(HERE, "..", "..", "..", "python", "sidecar");
const REAL_ENVMGR = join(REAL_SIDECAR_DIR, "envmgr.py");
const BLOCKED_SIDECAR_DIR = join(HERE, "__fixtures__", "blocked-sidecar");

test("CONTRACT: listEnvs() returns typed Env[] with exactly one active (REAL envmgr.py)", async (t) => {
  if (!existsSync(REAL_ENVMGR)) {
    t.skip(`envmgr.py not present at ${REAL_ENVMGR}`);
    return;
  }
  const client = createEnvClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 60_000 });
  const envs: Env[] = await client.listEnvs();
  assert.ok(Array.isArray(envs), "envs must be an array");
  assert.ok(envs.length >= 1, "the system env is always present, so at least one env");

  // every row is a well-formed Env (the boundary camelCased the snake_case JSON).
  for (const e of envs) {
    assert.equal(typeof e.id, "string");
    assert.match(e.id, /^env_/, "id is the env_<hash> form");
    assert.equal(typeof e.name, "string");
    assert.equal(typeof e.path, "string");
    assert.equal(typeof e.pythonPath, "string");
    assert.equal(typeof e.pythonVersion, "string");
    assert.equal(typeof e.packageCount, "number");
    assert.equal(typeof e.active, "boolean");
    assert.ok(
      ["venv", "virtualenv", "conda", "pyenv", "system", "engine"].includes(e.kind),
      `kind in the EnvKind union, got ${e.kind}`,
    );
    assert.ok(
      ["global", "project", "engine"].includes(e.scope),
      `scope in the EnvScope union, got ${e.scope}`,
    );
    assert.ok(
      ["studio", "engine", "external"].includes(e.managedBy),
      `managedBy in the union, got ${e.managedBy}`,
    );
  }

  // EXACTLY ONE active — the deterministic fallback (the system env).
  const active = envs.filter((e) => e.active);
  assert.equal(active.length, 1, "exactly one env must be marked active");
  // the system env is always present; the fallback should select it.
  const sys = envs.find((e) => e.kind === "system");
  if (sys) {
    assert.equal(active[0]?.id, sys.id, "the active fallback is the system env");
  }
});

test("CONTRACT: cudaInfo() returns a well-formed GpuInfo (hasNvidia:false on this mac)", async (t) => {
  if (!existsSync(REAL_ENVMGR)) {
    t.skip(`envmgr.py not present at ${REAL_ENVMGR}`);
    return;
  }
  const client = createEnvClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 60_000 });
  const gpu: GpuInfo = await client.cudaInfo();
  assert.equal(typeof gpu.hasNvidia, "boolean");
  assert.equal(typeof gpu.toolkitInstalled, "boolean");
  assert.ok(Array.isArray(gpu.gpus), "gpus must be an array");
  // this CI host is Apple-silicon macOS: no NVIDIA, no toolkit.
  if (process.platform === "darwin") {
    assert.equal(gpu.hasNvidia, false, "no NVIDIA on darwin");
    assert.equal(gpu.toolkitInstalled, false, "no CUDA toolkit on darwin");
    assert.equal(gpu.gpus.length, 0, "no NVIDIA GPUs enumerated on darwin");
  }
});

test("FAIL-CLOSED: a nemesis-BLOCK install is a RETURNED value (not a throw), verdict rides through", async () => {
  // point the client at the fake sidecar that emits the §8 blocked envelope.
  const client = createEnvClient({ sidecarDir: BLOCKED_SIDECAR_DIR, timeoutMs: 30_000 });
  // this must NOT throw — a block is a valid, renderable result.
  const res = await client.pkgInstall({ envId: "demo", spec: "evil-pkg", confirm: true });

  assert.equal(res.ok, false, "a block is ok:false");
  assert.equal(res.blocked, true, "blocked:true rides through");
  assert.equal(res.installed, undefined, "nothing was installed");
  assert.equal(res.command, "pkg.install");
  assert.ok(res.message?.includes("refused"), "the refusal message is surfaced");

  // the gate verdict is camelCased and carried — JS never decides; it renders.
  assert.ok(res.gate, "the gate summary must ride through");
  assert.equal(res.gate?.verdict, "block");
  assert.equal(res.gate?.score, 100);
  assert.equal(res.gate?.signed, true);
  assert.ok(Array.isArray(res.gate?.reasons));
  assert.ok(res.gate?.reasons.length >= 1, "blocking reasons are present");
  // scanned_at → scannedAt (snake→camel at the boundary).
  assert.equal(res.gate?.scannedAt, "2026-06-16T00:00:00Z");
  // the raw envelope is the escape hatch.
  assert.equal(res.raw.command, "pkg.install");
  assert.equal(res.raw.ok, false);
});

test("pkgInstall WITHOUT confirm returns a non-destructive PLAN (no fetch)", async (t) => {
  if (!existsSync(REAL_ENVMGR)) {
    t.skip(`envmgr.py not present at ${REAL_ENVMGR}`);
    return;
  }
  const client = createEnvClient({ sidecarDir: REAL_SIDECAR_DIR, timeoutMs: 60_000 });
  // no `confirm` → the real sidecar returns planned:true with a stage→scan→install
  // plan and stages/scans NOTHING. Proves the gated path is dry by default.
  const res = await client.pkgInstall({ envId: "system", spec: "numpy" });
  assert.equal(res.ok, true, "a dry plan is ok:true");
  assert.equal(res.planned, true, "planned:true — nothing fetched");
  assert.equal(res.installed, undefined, "nothing installed in a plan");
  assert.ok(res.plan, "the stage→scan→install plan is returned for preview");
});
