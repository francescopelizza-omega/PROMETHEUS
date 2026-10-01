// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/execute-guards.ts — the fail-closed checks every "this runs project code" path shares.
 *
 * `ide:test.run` applied three of them — sensitive-path denial, the nemesis run-gate, and the
 * telemetry launch-guard — and `ide:coverage.run` applied none, despite `coverage run -m pytest`
 * importing the workspace's conftest.py, its plugins and every test module. The asymmetry was
 * directly observable: on an untrusted workspace "Run tests" was refused with
 * "run gate refused: …" while "Run coverage" ran the identical suite.
 *
 * Written once here because two copies of a security sequence is how the second one comes to be
 * missing — the same drift this session found in gate()/gateFull() and in the three --force
 * guards. `label` only shapes the telemetry-failure wording, so a refusal still names its stage.
 */

export interface ExecuteGuardDeps {
  /** normalize the root and refuse a sensitive cwd (throws on refusal). */
  assertNotSensitivePath: (root: string) => string;
  /** the fail-closed nemesis run-gate. */
  runGate: (root: string) => Promise<{ mayLaunch: boolean; reason?: string }>;
  /** the telemetry launch-guard (CPU/RAM headroom). */
  readTele: () => Promise<{ guard: { allow: boolean; reason?: string } }>;
  /** render a thrown value as a message. */
  errString: (e: unknown) => string;
}

export type ExecuteGuardResult = { ok: true; root: string } | { ok: false; error: string };

/**
 * Run all three guards in order and return the NORMALIZED root, or the refusal.
 *
 * Order matters: normalize first so the gate and everything downstream see the same path, then
 * the gate (is this code allowed to run at all), then the resource guard (is there headroom).
 * A telemetry read that THROWS holds the launch — unavailable is not permission.
 */
export async function assertExecuteAllowed(
  root: string,
  label: string,
  deps: ExecuteGuardDeps,
): Promise<ExecuteGuardResult> {
  const normalized = deps.assertNotSensitivePath(root);
  const verdict = await deps.runGate(normalized);
  if (!verdict.mayLaunch) return { ok: false, error: `run gate refused: ${verdict.reason}` };
  try {
    const tele = await deps.readTele();
    if (!tele.guard.allow) {
      return {
        ok: false,
        error: `resource guard refused: ${tele.guard.reason ?? "over threshold"}`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: `telemetry unavailable (${deps.errString(e)}) — ${label} held (fail-closed)`,
    };
  }
  return { ok: true, root: normalized };
}
