// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * gate.spec.ts — a BLOCK verdict makes install impossible in the UI (file 10 §6.3).
 *
 * The single most important e2e: the gate is undeniable. With PROMETHEUS_GATE=enforce
 * and a fixture target nemesis flags, the verdict badge reads BLOCK and the Install
 * button is disabled (only the typed-confirm Force path can override). This exercises
 * the whole trinity: renderer → IPC → engine-bridge → real prometheus.py / nemesis.
 */
import { resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const MAIN =
  process.env.STUDIO_E2E_APP ??
  resolve(__dirname, "..", "..", "apps", "desktop", "out", "main", "index.js");

test("a blocked artifact cannot be installed", async () => {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, PROMETHEUS_GATE: "enforce" },
  });
  const win = await app.firstWindow();

  // open the Security activity and gate a fixture target nemesis flags.
  await win
    .getByLabel(/security/i)
    .first()
    .click();
  await win.getByTestId("gate-target").fill("evil/backdoor-demo");
  await win
    .getByRole("button", { name: /scan|gate/i })
    .first()
    .click();

  // the verdict is undeniable: BLOCK badge + a disabled Install.
  await expect(win.getByTestId("verdict-badge")).toContainText(/BLOCK/i);
  await expect(win.getByRole("button", { name: /^install$/i })).toBeDisabled();

  await app.close();
});
