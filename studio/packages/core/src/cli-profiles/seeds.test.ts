/**
 * seeds.test.ts — the profile seeds and the `--force` escape-hatch predicate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { forceOverrideAllowed, profileForbidsForce } from "./seeds.js";

test('the --force override opens on EXACTLY "1", never on a falsy-looking value', () => {
  /**
   * Every message the CLI prints says "Set PROM_ALLOW_FORCE=1 to override", so `1` is the only
   * documented value. Two of the three guard sites tested presence instead
   * (`!process.env.PROM_ALLOW_FORCE`), which fails OPEN on `0`, `false`, `no` and `off` — a CI
   * job setting `PROM_ALLOW_FORCE=0` believing it DISABLES the escape hatch actually enabled it,
   * and a forced install then ran unattended straight over a nemesis BLOCK.
   *
   * The third site had already been hardened, with a comment naming this exact failure. That is
   * why this is one shared predicate now rather than three copies: the two that drifted are the
   * whole §2 verb tree (generic.ts) and the REPL/session gate (command-exec.ts).
   */
  assert.equal(forceOverrideAllowed({ PROM_ALLOW_FORCE: "1" }), true);

  // the values a user would set to CLOSE the hatch must not open it
  for (const v of ["0", "false", "no", "off", "", "true", "yes", "2", " 1"]) {
    assert.equal(
      forceOverrideAllowed({ PROM_ALLOW_FORCE: v }),
      false,
      `PROM_ALLOW_FORCE=${JSON.stringify(v)} must not open the override`,
    );
  }
  assert.equal(forceOverrideAllowed({}), false, "unset must not open the override");
});

test("the ci profile is the one that forbids --force", () => {
  assert.equal(profileForbidsForce("ci"), true);
  assert.equal(profileForbidsForce("default"), false);
  assert.equal(profileForbidsForce(undefined), false);
});
