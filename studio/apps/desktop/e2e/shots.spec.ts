/**
 * e2e/shots.spec.ts — the REDESIGN VERIFICATION harness (handoff rule: "render and
 * screenshot before claiming any UI fix done. Never guess from CSS.").
 *
 * This is NOT a pixel-regression gate (smoke.spec.ts owns the one stable baseline). It
 * launches the real built app and writes full-window PNGs of every redesigned surface to
 * `e2e/.shots/` so the implementer can diff them side by side against
 * `handoff/reference-prototype.html`. It never fails on pixels — only on a surface that
 * refuses to mount, which is itself the signal worth failing on.
 *
 * Run: pnpm --filter @prometheus/desktop exec playwright test shots.spec.ts
 *      (after `pnpm --filter @prometheus/desktop run build`).
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { type LaunchedApp, launchApp } from "./electron-app.js";

const SHOTS = join(process.cwd(), "e2e", ".shots");
// cwd is studio/apps/desktop (per the `pnpm --filter @prometheus/desktop` run command above) —
// resolve the repo root relative to it rather than hardcoding a machine-specific absolute path.
const REPO_ROOT = resolve(process.cwd(), "..", "..", "..");

let launched: LaunchedApp;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.close();
});

/** Capture the whole window under `name` and settle the paint first. */
async function shoot(name: string): Promise<void> {
  await launched.page.waitForTimeout(500);
  await launched.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test("shot: home mission control", async () => {
  const { page } = launched;
  await page.getByRole("button", { name: "Home", exact: true }).click({ force: true });
  await expect(page.getByRole("main").first()).toBeVisible();
  await shoot("01-home");
});

test("shot: editor islands", async () => {
  const { page } = launched;
  await page.getByRole("button", { name: "Editor", exact: true }).click({ force: true });
  await expect(page.getByRole("main").first()).toBeVisible();
  await shoot("02-editor");
});

test("shot: editor with a real file (Pelly Monaco theme)", async () => {
  const { page } = launched;
  // Drive the app's OWN buses: set the workspace root FIRST (file reads are scoped to it),
  // then open a real source file so Monaco actually tokenizes — a themed editor cannot be
  // verified against an empty buffer.
  await page.evaluate((root) => {
    window.dispatchEvent(new CustomEvent("prometheus:open-folder", { detail: { path: root } }));
  }, REPO_ROOT);
  await page.waitForTimeout(800);
  await page.evaluate((path) => {
    window.dispatchEvent(new CustomEvent("prometheus:open-file", { detail: { path } }));
  }, join(REPO_ROOT, "prometheus.py"));
  await page.waitForTimeout(3000); // monaco chunk + file read + tokenizer
  await shoot("02b-editor-pelly");
});

test("shot: right rail open", async () => {
  const { page } = launched;
  // The TRAY is also a <complementary> ("Agent (minimised)"), so presence is not the
  // test — the expand button's presence is. Click it when the rail is minimised.
  const expand = page.getByRole("button", { name: "Expand right rail" });
  if (await expand.isVisible().catch(() => false)) await expand.click({ force: true });
  await expect(page.getByRole("complementary", { name: "Agent", exact: true })).toBeVisible();
  await shoot("03-rail-open");
});

test("shot: right rail tray", async () => {
  const { page } = launched;
  await page
    .getByRole("button", { name: /minimi[sz]e/i })
    .first()
    .click({ force: true })
    .catch(() => {});
  await shoot("04-rail-tray");
});

// handoff_3 §1: six rail nouns. Environments/Repos/Docs are Workspace SEGMENTS now and
// Extensions is a Catalog segment, so they have no rail button to click.
for (const route of ["Catalog", "Model Hub", "Security", "Workspace"]) {
  test(`shot: ${route}`, async () => {
    const { page } = launched;
    await page.getByRole("button", { name: route, exact: true }).click({ force: true });
    await expect(page.getByRole("main").first()).toBeVisible();
    await shoot(`05-${route.toLowerCase().replace(/\s+/g, "-")}`);
  });
}

/**
 * The SEGMENTS of the two merged routes (handoff_3 §2/§5).
 *
 * A rail shot only ever proves the route's DEFAULT segment mounts. That is precisely how
 * `routes/extensions.tsx` — the whole MCP / ACP connector manager — sat with no import site
 * at all after the §1 merge: the rail no longer had an Extensions button, Catalog defaulted
 * to Plugins, and nothing in the suite ever asked for the other two tabs. So each segment is
 * clicked and shot, and a segment that refuses to mount fails here.
 */
for (const [route, segments] of [
  ["Catalog", ["Plugins", "Extensions", "Skills"]],
  ["Workspace", ["Repos", "Environments", "Docs"]],
] as const) {
  for (const segment of segments) {
    test(`shot: ${route} / ${segment}`, async () => {
      const { page } = launched;
      await page.getByRole("button", { name: route, exact: true }).click({ force: true });
      await expect(page.getByRole("main").first()).toBeVisible();
      await page.getByRole("tab", { name: segment, exact: true }).click({ force: true });
      await expect(page.getByRole("tab", { name: segment, exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await shoot(`06-${route.toLowerCase().replace(/\s+/g, "-")}-${segment.toLowerCase()}`);
    });
  }
}

/**
 * §4's verdict history sits below the fold on a 900px-tall window, so the route shot alone
 * never covers it — and "below the fold" is exactly where a broken island hides.
 */
test("shot: Security / verdict history", async () => {
  const { page } = launched;
  await page.getByRole("button", { name: "Security", exact: true }).click({ force: true });
  // `Panel` renders its title in a plain <header>, not a heading role, so this matches the
  // text rather than a role that does not exist.
  const panel = page.getByText("Verdict history", { exact: true });
  await expect(panel).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await shoot("06-security-verdict-history");
});

/**
 * §7's own worked example: "it crushed the catalog list to 140px at 920px viewport".
 *
 * The rule §7 states (flex-wrap + a min-width on BOTH panels) is only observable NARROW, so
 * every two-panel route gets a shot at the width the regression was found at. The window is
 * restored afterwards so the shot order above stays reproducible.
 */
test("shot: merged routes at ~900px (the §7 crush width)", async () => {
  const { page } = launched;
  const bounds = await page.evaluate(() => ({ w: window.outerWidth, h: window.outerHeight }));
  await page.setViewportSize({ width: 900, height: 900 });
  for (const route of ["Catalog", "Model Hub", "Security", "Workspace"]) {
    await page.getByRole("button", { name: route, exact: true }).click({ force: true });
    await expect(page.getByRole("main").first()).toBeVisible();
    await shoot(`07-narrow-${route.toLowerCase().replace(/\s+/g, "-")}`);
  }
  await page.setViewportSize({ width: bounds.w, height: bounds.h });
});
