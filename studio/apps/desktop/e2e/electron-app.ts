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
  /** the per-run temp PROMETHEUS_HOME, when launched with `isolateHome` (else undefined). */
  prometheusHome?: string;
  /** the main-process stderr collected so far (for failure diagnostics). */
  stderr(): string;
  close(): Promise<void>;
}

const MAIN_ENTRY = "out/main/index.js";
const WINDOW = { width: 1440, height: 900, scale: 1 };

/** Options for `launchApp`. A bare number is still accepted (back-compat: `launchApp(45_000)`). */
export interface LaunchAppOptions {
  timeoutMs?: number;
  /**
   * Seed the freshly-minted userData dir BEFORE the app process starts — e.g. write
   * `settings.json` so a hook is already configured when main's settings-ipc does its
   * startup `publish()`. Runs after the temp dir exists, before `electron.launch`.
   */
  beforeLaunch?: (userDataDir: string, prometheusHome?: string) => void | Promise<void>;
  /**
   * Give the app a per-run temp `PROMETHEUS_HOME` as well as a temp userData. The global
   * settings layer (hooks, gateStrict, budget.*) lives in `$PROMETHEUS_HOME/config/settings.json`
   * now, shared with the CLI, so a spec that seeds settings must seed THERE — and must not do
   * it in the developer's real `~/.prometheus`, where a test hook would become a real one.
   */
  isolateHome?: boolean;
}

/**
 * Launch the built Electron app headlessly-friendly. Rejects with the captured main-process
 * stderr if the first window never appears within `timeoutMs`.
 */
export async function launchApp(opts: number | LaunchAppOptions = {}): Promise<LaunchedApp> {
  const {
    timeoutMs = 30_000,
    beforeLaunch,
    isolateHome = false,
  } = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const userDataDir = mkdtempSync(join(tmpdir(), "prom-e2e-"));
  const prometheusHome = isolateHome ? mkdtempSync(join(tmpdir(), "prom-e2e-home-")) : undefined;
  const cleanup = (): void => {
    rmSync(userDataDir, { recursive: true, force: true });
    if (prometheusHome) rmSync(prometheusHome, { recursive: true, force: true });
  };
  if (beforeLaunch) await beforeLaunch(userDataDir, prometheusHome);
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
      ...(prometheusHome ? { PROMETHEUS_HOME: prometheusHome } : {}),
    },
  });

  // Pin the OS color scheme to DARK. The appearance preference defaults to "system", so a
  // reviewer's light-mode Mac would otherwise render the whole suite in the light palette and
  // every screenshot would be a lie about the shipped (dark-first) design. nativeTheme is the
  // real seam prefers-color-scheme reads, so this needs no app-side test hook.
  await app
    .evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    })
    .catch(() => {});

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
    cleanup();
    throw e;
  }

  // NOTE: animation/caret determinism is handled by playwright.config's
  // `toHaveScreenshot: { animations: "disabled", caret: "hide" }` — we do NOT inject a
  // <style> here: the app ships a STRICT prod CSP (style-src 'self') that blocks an inline
  // style tag, and addStyleTag would throw on the real (non-dev) bundle we deliberately drive.

  // Seed the renderer's own persistence, then reload so the app boots ALREADY settled:
  //   - appearance.theme = "dark": the shipped design is dark-first, and the default
  //     preference is "system" — on a light-mode machine every screenshot would otherwise
  //     show a palette the design was never authored against. nativeTheme (above) covers
  //     the OS side; this covers the persisted side, so both agree.
  //   - the onboarding flag: a fresh temp userData otherwise raises the first-run wizard as
  //     a modal that intercepts every click. Pre-marking it "done" is deterministic where
  //     racing a Skip click is not.
  await page
    .evaluate(
      ([themeKey, onboardKey]) => {
        window.localStorage.setItem(themeKey, JSON.stringify({ theme: "dark" }));
        window.localStorage.setItem(onboardKey, JSON.stringify({ skipped: true, ts: 0 }));
      },
      ["prometheus.appearance", "prometheus.onboarding.v1"] as const,
    )
    .catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page
    .getByRole("navigation", { name: "Activity bar" })
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(() => {});

  // Belt and braces: if the wizard still made it up (a shape change to the persisted flag),
  // dismiss it rather than letting it eat every click in the suite.
  const wizard = page.getByRole("dialog", { name: /first-run|welcome/i });
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
    ...(prometheusHome ? { prometheusHome } : {}),
    stderr: () => stderr,
    close: async () => {
      await app.close().catch(() => {});
      cleanup();
    },
  };
}

/** One `model:endpoints` entry (the shape `localai endpoints` returns per row). */
export interface FakeModelEndpoint {
  name: string;
  baseUrl: string;
}

/**
 * Monkey-patch the LIVE main process's `model:endpoints` IPC handler to return a fixed
 * result, via `ElectronApplication.evaluate` — which runs in the REAL main process (the same
 * `ipcMain` singleton `main/index.ts` registered every handler against, reached the same way
 * `launchApp` already reaches `nativeTheme` above).
 *
 * This is the e2e substitute for a real engine-bridge sidecar: driving a chat turn needs SOME
 * endpoint in the Model Hub picker, and spawning the real python sidecar (which itself shells
 * out to probe local runners and query configured cloud providers) is exactly the kind of
 * heavy, non-deterministic dependency an e2e suite should not carry. Everything downstream of
 * this — the actual model HTTP traffic — stays completely real: a real `node:http` server,
 * real loopback sockets, real SSE parsing, run for real by the real main-process `ai:stream`
 * handler. Only the "which servers exist" catalog is substituted.
 */
export async function overrideModelEndpoints(
  launched: LaunchedApp,
  result: { ok: boolean; local: FakeModelEndpoint[]; openApi: FakeModelEndpoint[] },
): Promise<void> {
  await launched.app.evaluate(({ ipcMain }, r) => {
    const channel = "model:endpoints";
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async () => r);
  }, result);
}

/**
 * `shimLocalModelsProbe` used to live here — it patched the RENDERER's `window.fetch` so
 * `endpoint-hook.ts`'s `probeServedModels` (a direct `GET {baseUrl}/models`) could resolve
 * without a real network dispatch, working around a REAL bug this suite found live: the
 * production CSP (`connect-src 'self'`, `main/index.ts`) refuses a renderer `fetch` to
 * `http://127.0.0.1:<port>` (`TypeError: Failed to fetch`), so every local runner silently
 * vanished from the Model Hub picker in the packaged app.
 *
 * Task #18 fixed the underlying bug (the probe now runs in MAIN via `ai:probeModels`, the
 * same detour `ai:stream` already takes for chat completions), which made the shim not just
 * unnecessary but WRONG to keep: it patched a `window.fetch` call the renderer no longer
 * makes, so leaving it in place would silently stop testing the real path. Specs that need a
 * served model now pass `servedModels` to `startFakeModelServer` (`fake-model-server.ts`),
 * which answers `GET {baseUrl}/models` for real. See `model-probe.spec.ts` for the regression
 * test pinning the fix itself.
 */
