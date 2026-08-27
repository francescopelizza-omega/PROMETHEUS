/**
 * gate-full.test.ts — the FULL-verdict twin of gate().
 *
 * `gate()` and `gateFull()` are two entry points onto the same nemesis invocation, and the
 * option-shaped-target protection landed on only one of them. Everything here exists to keep the
 * two from drifting apart again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { gateFull } from "./gate-full.js";

test("an option-shaped scan target FAILS CLOSED — it is never handed to nemesis as a flag", async () => {
  /**
   * nemesis reads `-` as "the body is on stdin". `runNemesis` writes no stdin for a gate and
   * closes the pipe, so a target of `-` made it scan an EMPTY body and answer
   * `verdict:"allow", risk_score:0`. `gateFull` then reconciled allow-vs-allow into a clean
   * `NemesisVerdict` with `safe_to` straight from that JSON — so the desktop Security Center's
   * scan box reported SAFE for something that had never been scanned at all.
   *
   * The sibling `gate()` has refused these since the same defect was fixed there; this twin
   * accepted them, and it is the one the desktop's securityGate/securityGateFull IPC, the ext
   * rescan path and the CLI's `gate` command all reach.
   */
  for (const target of ["-", "-rf", "--help", "  --policy=/tmp/x"]) {
    const v = await gateFull(target);
    assert.notEqual(v.verdict, "allow", `${target} must never come back as allow`);
    assert.equal(v.target, target, "the verdict must name the target that was REQUESTED");
  }
});

test("an empty target is still refused", async () => {
  for (const target of ["", "   "]) {
    const v = await gateFull(target);
    assert.notEqual(v.verdict, "allow");
  }
});
