/**
 * boot.spec.ts — the app boots and renders the shell (file 10 §6.3).
 */
import { resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

/** The main entry to launch: the packaged app's main (STUDIO_E2E_APP) or the dev build. */
const MAIN =
  process.env.STUDIO_E2E_APP ??
  resolve(__dirname, "..", "..", "apps", "desktop", "out", "main", "index.js");

test("app boots and the shell root mounts", async () => {
  const app = await electron.launch({ args: [MAIN], env: { ...process.env } });
  const win = await app.firstWindow();
  await expect(win.locator("#root")).toBeVisible();
  // the §4 status bar's ambient nemesis shield is always present (rule #2).
  await expect(win.getByText(/nemesis/i).first()).toBeVisible();
  await app.close();
});
