/**
 * marketplace-ext.test.ts — the PURE row-map + verdict-flow reducer (APP-060).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtInfoView } from "../shared/ipc-contract.js";
import {
  WARN_CONFIRM_PHRASE,
  extInfoToRow,
  gateTierToWorst,
  installDecision,
  warnConfirmAccepted,
} from "./marketplace-ext.js";

const INFO: ExtInfoView = {
  id: "pub.sample",
  label: "Sample",
  version: "1.0.0",
  installPath: "/x/pub.sample",
  active: true,
  permissions: ["Engine commands: list"],
};

test("gateTierToWorst: only the 4 real tiers map; anything else → undefined (never GREEN)", () => {
  assert.equal(gateTierToWorst("allow"), "allow");
  assert.equal(gateTierToWorst("warn"), "warn");
  assert.equal(gateTierToWorst("block"), "block");
  assert.equal(gateTierToWorst("error"), "error");
  assert.equal(gateTierToWorst(undefined), undefined);
  assert.equal(gateTierToWorst("green"), undefined); // not a real tier → unknown, not clean
});

test("extInfoToRow: installed + non-installable; worstVerdict is the STORED tier or absent", () => {
  const unscanned = extInfoToRow(INFO);
  assert.equal(unscanned.installed, true);
  assert.equal(unscanned.installable, false);
  assert.equal(unscanned.worstVerdict, undefined); // no stored verdict → chip shows unknown
  assert.match(unscanned.summary ?? "", /v1\.0\.0 · active · 1 permission/);

  const scanned = extInfoToRow({
    ...INFO,
    active: false,
    verdict: { tier: "warn", riskScore: 40, findingsCount: 2, scannedAt: "t" },
  });
  assert.equal(scanned.worstVerdict, "warn");
  assert.match(scanned.summary ?? "", /disabled/);
});

test("installDecision: RED blocks (no force), WARN needs typed confirm, unknown is fail-closed", () => {
  assert.equal(installDecision("allow"), "proceed");
  assert.equal(installDecision("warn"), "confirm-warn");
  assert.equal(installDecision("block"), "blocked");
  assert.equal(installDecision("error"), "blocked");
  assert.equal(installDecision(undefined), "blocked"); // never coalesce unknown → proceed
});

test("warnConfirmAccepted: exact literal only", () => {
  assert.equal(warnConfirmAccepted(WARN_CONFIRM_PHRASE), true);
  assert.equal(warnConfirmAccepted("  INSTALL ANYWAY  "), true); // trimmed
  assert.equal(warnConfirmAccepted("install anyway"), false); // case-sensitive
  assert.equal(warnConfirmAccepted("yes"), false);
});
