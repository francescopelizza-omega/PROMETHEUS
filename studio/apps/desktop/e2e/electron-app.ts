/**
 * e2e/electron-app.ts — the Electron launcher fixture (APP-069).
 *
 * Launches the BUILT app (out/main/index.js — NOT the vite dev server: the dev-only CSP relax
 * plugin makes dev diverge from prod, and the black-window/CSP class of bug only reproduces on
 * the built bundle). Points userData at a per-run temp dir so a real
 * `~/Library/Application Support/Prometheus Studio` is never touched, forces a deterministic
 * window size + scale via env the main process reads, and — critically — captures the MAIN
 * process stderr so a never-rendering renderer (the black-window bug) fails with the real cause
 * instead of an opaque timeout.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ElectronApplication, type Page, _electron as electron } from "@playwright/test";

/** A launched app + its temp userData dir + the collected main-process stderr. */
export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  /** the main-process stderr collected so far (for failure diagnostics). */
  stderr(): string;
  close(): Promise<void>;
}

const MAIN_ENTRY = "out/main/index.js";
const WINDOW = { width: 1440, height: 900, scale: 1 };

/**
 * Launch the built Electron app headlessly-friendly. Rejects with the captured main-process
 * stderr if the first window never appears within `timeoutMs`.
 */
export async function launchApp(timeoutMs = 30_000): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), "prom-e2e-"));
  const args = [
    MAIN_ENTRY,
    `--user-data-dir=${userDataDir}`,
    // GitHub ubuntu runners run as root → Chromium's SUID sandbox aborts without these.
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
  ];
  const app = await electron.launch({
    args,
    env: {
      ...process.env,
      PROM_E2E: "1", // main reads this to pin bounds + skip first-run side effects
      PROM_E2E_WIDTH: String(WINDOW.width),
      PROM_E2E_HEIGHT: String(WINDOW.height),
      PROM_E2E_SCALE: String(WINDOW.scale),
    },
  });

  // Attach to stderr BEFORE awaiting the window, so a launch that never paints still yields the cause.
  let stderr = "";
  const proc = app.process();
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  let page: Page;
  try {
    page = await Promise.race([
      app.firstWindow(),
      new Promise<Page>((_, reject) =>
        setTimeout(
          () => reject(new Error(`no window after ${timeoutMs}ms. main stderr:\n${stderr}`)),
          timeoutMs,
        ),
      ),
    ]);
  } catch (e) {
    await app.close().catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    throw e;
  }

  // NOTE: animation/caret determinism is handled by playwright.config's
  // `toHaveScreenshot: { animations: "disabled", caret: "hide" }` — we do NOT inject a
  // <style> here: the app ships a STRICT prod CSP (style-src 'self') that blocks an inline
  // style tag, and addStyleTag would throw on the real (non-dev) bundle we deliberately drive.

  // A fresh temp userData has no onboarding flag → the APP-064 first-run wizard shows as a
  // modal that intercepts every click. Dismiss it (Skip) so the smoke flows drive the real
  // shell; the dialog then persists "done" so it won't reappear this run.
  const wizard = page.getByRole("dialog", { name: "First-run setup" });
  if (await wizard.isVisible().catch(() => false)) {
    await page
      .getByRole("button", { name: "Skip" })
      .click()
      .catch(() => {});
    await wizard.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }

  return {
    app,
    page,
    userDataDir,
    stderr: () => stderr,
    close: async () => {
      await app.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
