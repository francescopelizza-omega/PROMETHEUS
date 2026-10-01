// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * e2e/path-completion.spec.ts — the "@"-path completion feature, driven end-to-end
 * against the REAL built app (no unit-level DOM/jsdom environment exists in this repo,
 * so this Electron e2e harness is the only place the renderer hook's real keyboard
 * handling + IPC round-trip + splice logic are ever exercised together).
 *
 * A fresh e2e launch has no workspace open (baseDir would be ""), so the real
 * `pathCompletion:list` handler would legitimately no-op (dir is required). That's a
 * real, correct degraded-mode behavior, but not what this spec is proving: it monkey-
 * patches the MAIN process's `pathCompletion:*` ipcMain handlers (the same pattern
 * `overrideModelEndpoints` in electron-app.ts uses for `model:endpoints`) to a fixed,
 * deterministic response, so what's under test is the RENDERER wiring — trigger
 * detection, keyboard handling, and the accept/splice logic — not the real filesystem
 * (already covered by packages/core/path-completion's + path-completion-ipc.ts's own
 * unit tests).
 */
import { expect, test } from "@playwright/test";

import { type LaunchedApp, launchApp } from "./electron-app.js";

let launched: LaunchedApp;
let recordUseCalls: unknown[] = [];

test.beforeAll(async () => {
  launched = await launchApp();
  // Fixed, deterministic completion + recording of every recordUse call — see file doc.
  await launched.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("pathCompletion:list");
    ipcMain.handle("pathCompletion:list", async () => ({
      ok: true,
      entries: [{ name: "README.md", isDir: false, positions: [] }],
    }));
    ipcMain.removeHandler("pathCompletion:recordUse");
    ipcMain.handle("pathCompletion:recordUse", async (_e, arg: unknown) => {
      (globalThis as { __recordUseCalls?: unknown[] }).__recordUseCalls ??= [];
      (globalThis as { __recordUseCalls?: unknown[] }).__recordUseCalls?.push(arg);
      return { ok: true };
    });
  });
});

test.afterAll(async () => {
  await launched?.close();
});

test("ask bar: typing @ + a fragment, then Tab, splices the completed file into the buffer", async () => {
  const { page } = launched;
  const askBar = page.getByLabel("Ask Prometheus");
  await expect(askBar).toBeVisible();

  await askBar.click();
  await askBar.fill("hello @read");
  // give the (fake, but still async) IPC round-trip a moment to resolve.
  await page.waitForTimeout(300);
  await askBar.press("Tab");
  await page.waitForTimeout(100);

  const value = await askBar.inputValue();
  expect(value).toBe("hello @README.md ");
});

test("ask bar: Escape closes the dropdown without altering the buffer", async () => {
  const { page } = launched;
  const askBar = page.getByLabel("Ask Prometheus");
  await askBar.click();
  await askBar.fill("");
  await askBar.fill("@read");
  await page.waitForTimeout(300);
  await askBar.press("Escape");
  const value = await askBar.inputValue();
  expect(value).toBe("@read");
  // Escape must not have accepted anything — no frecency hit recorded. __recordUseCalls
  // was set via app.evaluate (MAIN process globalThis), so it must be read back the same
  // way — page.evaluate runs in the RENDERER, a completely different globalThis.
  recordUseCalls = await launched.app.evaluate(
    () => (globalThis as { __recordUseCalls?: unknown[] }).__recordUseCalls ?? [],
  );
  expect(recordUseCalls).toHaveLength(0);
});
