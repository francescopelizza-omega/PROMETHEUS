// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * playwright.config.ts — the e2e test projects (file 10 §6.3).
 *
 * Two projects: `e2e-dev` runs the smoke set against the electron-vite DEV build
 * (apps/desktop/out/main/index.js) on every push; `e2e-packaged` runs the same specs
 * against the actually-built, signed app (nightly + pre-release) to catch
 * asar/extraResources/path-resolution regressions dev mode hides. @playwright/test is
 * a CI-time devDependency (installed there, not in this dev env).
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  projects: [
    // dev build smoke (every push) — the harness launches out/main/index.js.
    { name: "e2e-dev", use: { headless: true } },
    // packaged build smoke (nightly + pre-release) — launches the built app via
    // STUDIO_E2E_APP; same specs, real artifact.
    { name: "e2e-packaged", use: { headless: true } },
  ],
});
