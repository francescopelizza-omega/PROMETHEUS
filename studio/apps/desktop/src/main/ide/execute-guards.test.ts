/**
 * execute-guards.test.ts — the fail-closed sequence every "runs project code" path shares.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertExecuteAllowed } from "./execute-guards.js";

const ok = {
  assertNotSensitivePath: (r: string) => `${r}/normalized`,
  runGate: async () => ({ mayLaunch: true }),
  readTele: async () => ({ guard: { allow: true } }),
  errString: (e: unknown) => String(e),
};

test("a workspace the run-gate refuses cannot execute project code", async () => {
  /**
   * `ide:coverage.run` had NONE of these guards while its twin `ide:test.run` had all three,
   * and `coverage run -m pytest` imports the workspace's conftest.py, its plugins and every test
   * module — genuine arbitrary-code execution. The asymmetry was directly observable: on an
   * untrusted workspace "Run tests" was refused with "run gate refused: …" while "Run coverage"
   * ran the identical suite.
   */
  const res = await assertExecuteAllowed("/ws", "coverage run", {
    ...ok,
    runGate: async () => ({ mayLaunch: false, reason: "nemesis BLOCK" }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error, "run gate refused: nemesis BLOCK");
});

test("the resource guard holds a launch, and an UNAVAILABLE telemetry read holds it too", async () => {
  // Unavailable is not permission: a telemetry read that throws must fail closed.
  const over = await assertExecuteAllowed("/ws", "coverage run", {
    ...ok,
    readTele: async () => ({ guard: { allow: false, reason: "cpu 96%" } }),
  });
  assert.equal(over.ok === false && over.error, "resource guard refused: cpu 96%");

  const broken = await assertExecuteAllowed("/ws", "coverage run", {
    ...ok,
    readTele: async () => {
      throw new Error("no telemetry");
    },
  });
  assert.equal(broken.ok, false);
  assert.match(broken.ok === false ? broken.error : "", /coverage run held \(fail-closed\)/);
});

test("a sensitive root is refused before the gate ever runs", async () => {
  // Normalization comes FIRST so the gate and everything downstream judge the same path.
  let gateRan = false;
  await assert.rejects(
    assertExecuteAllowed("/etc", "test run", {
      ...ok,
      assertNotSensitivePath: () => {
        throw new Error("sensitive path refused");
      },
      runGate: async () => {
        gateRan = true;
        return { mayLaunch: true };
      },
    }),
    /sensitive path refused/,
  );
  assert.equal(gateRan, false, "the gate ran on a path that should have been refused first");
});

test("the happy path returns the NORMALIZED root, not the raw one", async () => {
  // Downstream must use the normalized path, or the guard checked one string and the sidecar
  // received another.
  const res = await assertExecuteAllowed("/ws", "test run", ok);
  assert.deepEqual(res, { ok: true, root: "/ws/normalized" });
});
