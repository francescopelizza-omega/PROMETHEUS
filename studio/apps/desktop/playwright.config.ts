/**
 * playwright.config.ts — the e2e harness config (APP-069).
 *
 * These specs launch the REAL built Electron app (out/main/index.js) via `_electron.launch`
 * and drive smoke flows + visual snapshots, so "verify UI visually" stops being manual. They
 * use Playwright's OWN runner (NOT scripts/run-tests.mjs — that node:test runner prunes `e2e/`
 * and can't import @playwright/test). Run: `pnpm --filter @prometheus/desktop e2e` (which builds
 * the electron-vite bundles first, since the launcher needs out/main/index.js + out/renderer).
 *
 * Determinism: the app window is sized + deviceScaleFactor-pinned via env the main process reads
 * (PROM_E2E_*), animations are killed in-spec, and snapshots are auto-suffixed per-platform by
 * Playwright (`-darwin` / `-linux`) — so mac-local and linux-CI baselines never fight. CI is the
 * baseline authority (commit linux baselines from the e2e job; local runs are for iteration).
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // per-run artifacts (never committed); snapshots live beside the spec (e2e/__screenshots__).
  outputDir: "e2e/.artifacts",
  snapshotDir: "e2e/__screenshots__",
  fullyParallel: false, // one Electron app at a time (shared userData / window bounds)
  workers: 1,
  // e2e drives a real GPU-composited app; a rare transient (launch/animation timing) auto-retries
  // once rather than flaking the gate — standard e2e practice, not masking a real regression.
  retries: 1,
  timeout: 60_000, // an Electron cold-launch + first paint is slow
  expect: {
    timeout: 15_000,
    // OS font-hinting / subpixel AA differ mac↔linux — allow a small pixel-diff ratio.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled", caret: "hide" },
  },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
