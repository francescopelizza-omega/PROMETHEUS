/**
 * e2e/baselines.spec.ts — the §9 VISUAL ACCEPTANCE gate.
 *
 * "A green typecheck is not a layout verification — that's how 2026 was lost."
 *
 * One committed baseline per redesigned surface. Unlike `shots.spec.ts` (which writes
 * PNGs for a human to eyeball against `handoff_2/reference-prototype.html`), these FAIL
 * the build when a surface changes shape. That is the whole point: the redesign's layout
 * is now something CI can defend, not something a reviewer has to remember.
 *
 * What is and is not snapshotted, deliberately:
 *   - the SHELL CHROME (TopBar, ActivityBar, StatusBar) and the Home islands are stable
 *     and are snapshotted;
 *   - live-varying regions are masked, not excluded — CPU/RAM meters, the clock-derived
 *     greeting, and the engine error string all change between runs while the LAYOUT
 *     around them does not. Masking keeps the geometry under test and drops the noise;
 *   - Monaco's canvas and the activity-rail glyphs carry GPU anti-aliasing jitter, so the
 *     editor is snapshotted as its ISLAND FRAME (tree + tab strip + terminal), not its
 *     text surface.
 *
 * Baselines live in `e2e/__screenshots__/` and are per-platform (Playwright suffixes
 * `-darwin`/`-linux`). CI is the authority; a local re-record is for iteration.
 * Re-record: `pnpm --filter @prometheus/desktop run e2e:update`.
 */
import { type Locator, type Page, expect, test } from "@playwright/test";

import { type LaunchedApp, launchApp } from "./electron-app.js";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.close();
});

/** Regions whose CONTENT legitimately changes run-to-run; their geometry still counts. */
function volatileRegions(page: Page): Locator[] {
  return [
    // CPU/RAM percentages + bar widths (the telemetry poll is live)
    page
      .locator('[aria-label="System health"]')
      .locator("xpath=.."),
    page.getByText(/CPU|RAM/).first(),
    // the engine error carries an absolute path that differs per machine
    page
      .getByText(/not found at|unreachable/)
      .first(),
    // the greeting is derived from the wall clock
    page
      .getByText(/Good (morning|afternoon|evening)|Still up\?/)
      .first(),
  ];
}

test("baseline: shell chrome — TopBar", async () => {
  const { page } = launched;
  await page.getByRole("button", { name: "Home", exact: true }).click({ force: true });
  await page.waitForTimeout(600);
  await expect(page.getByRole("banner")).toHaveScreenshot("shell-topbar.png");
});

test("baseline: shell chrome — ActivityBar rail", async () => {
  const { page } = launched;
  // A TIGHTER ratio than the project default, and this is the test that proved why it is
  // needed: handoff_3 §1 removed three icons from the rail and the shot still PASSED at the
  // global `maxDiffPixelRatio: 0.02`. The rail is 46×816 ≈ 37.5k px, so 2% is ~750 px — more
  // than three small stroke icons occupy on a mostly-empty column. The global tolerance
  // exists for cross-platform font antialiasing, and this surface has NO TEXT, so it can
  // afford to be strict. Anything that changes the rail's contents must now fail here.
  await expect(page.getByRole("navigation", { name: "Activity bar" })).toHaveScreenshot(
    "shell-activitybar.png",
    { maxDiffPixelRatio: 0 },
  );
});

test("baseline: shell chrome — StatusBar", async () => {
  const { page } = launched;
  await expect(page.getByRole("contentinfo")).toHaveScreenshot("shell-statusbar.png");
});

test("baseline: Home mission control", async () => {
  const { page } = launched;
  await page.getByRole("button", { name: "Home", exact: true }).click({ force: true });
  await page.waitForTimeout(700);
  await expect(page.getByRole("main")).toHaveScreenshot("home-mission-control.png", {
    mask: volatileRegions(page),
  });
});

test("baseline: agent rail — tray", async () => {
  const { page } = launched;
  const minimise = page.getByRole("button", { name: /minimi[sz]e/i }).first();
  if (await minimise.isVisible().catch(() => false)) await minimise.click({ force: true });
  await page.waitForTimeout(400);
  await expect(page.getByRole("complementary", { name: /minimised/i })).toHaveScreenshot(
    "rail-tray.png",
  );
});

test("baseline: agent rail — open", async () => {
  const { page } = launched;
  const expand = page.getByRole("button", { name: "Expand right rail" });
  if (await expand.isVisible().catch(() => false)) await expand.click({ force: true });
  await page.waitForTimeout(500);
  await expect(page.getByRole("complementary", { name: "Agent", exact: true })).toHaveScreenshot(
    "rail-open.png",
  );
});

/**
 * The two DECISION cards (§9 requires a baseline for each).
 *
 * They get their own app instance, and they are last in the file, because reaching them
 * means swapping the renderer root for the harness — which would leave the shared app in
 * the wrong state for every test above. Neither card is reachable the normal way here: the
 * verdict card needs a real nemesis scan and the permission card a real proposed edit, and
 * a headless run has no engine and no model. Faking the IPC would produce a screenshot of
 * the fakes; rendering the components with fixed props produces a screenshot of the LAYOUT,
 * which is what a baseline is for.
 */
test("baseline: decision cards — verdict + permission", async () => {
  const harness = await launchApp();
  try {
    await harness.page.evaluate(() => {
      localStorage.setItem("prometheus.e2e.visualHarness", "1");
    });
    await harness.page.reload();
    await harness.page.waitForSelector('[aria-label="visual harness"]', { timeout: 15_000 });
    await harness.page.waitForTimeout(400);
    await expect(harness.page.getByTestId("baseline-verdict-card")).toHaveScreenshot(
      "card-verdict.png",
    );
    await expect(harness.page.getByTestId("baseline-permission-card")).toHaveScreenshot(
      "card-permission.png",
    );
  } finally {
    await harness.close();
  }
});

test("baseline: Editor island frame", async () => {
  const { page } = launched;
  await page.getByRole("button", { name: "Editor", exact: true }).click({ force: true });
  await page.waitForTimeout(900);
  // The whole WINDOW, not the <main> element: Monaco mounts an absolutely-positioned
  // host inside it, and an element-scoped capture of that subtree intermittently returns
  // nothing. The window shot still gates exactly what this baseline is for — the island
  // frame (rail · tree · editor · terminal) and its 8px gaps. With no folder open the
  // surface is static: the tree shows its empty state, the terminal reports the missing
  // pty backend, and Monaco has no text to anti-alias.
  await expect(page).toHaveScreenshot("editor-islands.png");
});
