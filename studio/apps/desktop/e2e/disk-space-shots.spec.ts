// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * e2e/disk-space-shots.spec.ts — the Disk space panel and its administrator door, rendered by
 * the real built app (one launch) and written to `e2e/.shots/disk-*.png`.
 *
 * Measures a small temp folder (the sidecar runs as the user), then presses "Open as
 * administrator…": the REAL privileged gate raises the REAL approval dialog with the exact root
 * command. The spec screenshots it and presses Deny — nothing runs, no password dialog appears,
 * and the panel says so. It never presses Approve.
 *
 * Isolated: temp userData and a temp PROMETHEUS_HOME (the audit line of the denied request lands
 * there, not in the developer's home).
 *
 * Run: pnpm --filter @prometheus/desktop run build
 *      pnpm --filter @prometheus/desktop exec playwright test disk-space-shots.spec.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";

import { expect, test } from "@playwright/test";

import { type LaunchedApp, launchApp } from "./electron-app.js";

const SHOTS = join(process.cwd(), "e2e", ".shots");
// ONE launch: a failure must not respawn the app for a retry or for the next test
test.describe.configure({ mode: "serial", retries: 0 });
let launched: LaunchedApp;
let tree: string;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  tree = mkdtempSync(join(tmpdir(), "prom-disk-shot-"));
  const sizes: [string, number][] = [
    ["photos", 6 << 20],
    ["videos", 4 << 20],
    ["projects", 2 << 20],
    ["downloads", 1 << 20],
    ["music", 512 << 10],
    ["notes", 128 << 10],
  ];
  for (const [name, size] of sizes) {
    mkdirSync(join(tree, name, "a"), { recursive: true });
    writeFileSync(join(tree, name, "a", "data.bin"), Buffer.alloc(size));
    writeFileSync(join(tree, name, "b.bin"), Buffer.alloc(Math.floor(size / 3)));
  }
  launched = await launchApp({ isolateHome: true, timeoutMs: 60_000 });
});

test.afterAll(async () => {
  await launched?.close();
  rmSync(tree, { recursive: true, force: true });
});

async function shoot(name: string): Promise<void> {
  await launched.page.waitForTimeout(600);
  await launched.page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test("shot: Disk space panel — treemap and pie of a measured folder", async () => {
  const { page } = launched;
  await page.getByRole("button", { name: "Home", exact: true }).click({ force: true });
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("ide:run-shell-command", { detail: "panel.disk" })),
  );
  const folder = page.getByLabel("folder to measure");
  await expect(folder).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Maximize bottom panel" }).click();
  await folder.fill(tree);
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(
    page.getByText("photos", { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await shoot("disk-01-treemap");
  await page.getByRole("tab", { name: "Pie" }).click();
  await shoot("disk-02-pie");
});

test("shot: Open as administrator — the real approval dialog, then Deny", async () => {
  const { page } = launched;
  await page.getByRole("button", { name: "Open as administrator…" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Approve a privileged command" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText("disk_space.py");
  await expect(dialog).toContainText("its own window");
  // the exact command is what the human approves: it must be on screen, not scrolled away by
  // the script preview while focus sits on Deny
  await expect(dialog.getByRole("heading")).toBeInViewport();
  await expect(dialog.locator("code").first()).toBeInViewport();
  await expect(dialog.locator("code").first()).toContainText("sudo");
  // xterm's own stylesheet is loaded: its input helper is not drawn as a grey box
  await expect(page.locator(".xterm-helper-textarea")).toBeHidden();
  await shoot("disk-03-admin-approval");
  await dialog.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.getByText("Not opened — you denied it.")).toBeVisible({ timeout: 15_000 });
  await shoot("disk-04-admin-denied");
});

test("a very long command keeps the command AND the buttons on screen", async () => {
  // A fake request straight from main to this window (main refuses any decision for an id it
  // never issued). 2,400 characters of argv used to push Approve/Deny below a clipped dialog.
  const { app, page } = launched;
  const long = Array.from({ length: 120 }, (_, i) => `/opt/some/rather/long/path-${i}`);
  const view = {
    id: "e2e-long-command",
    commandLine: `sudo rm -f ${long.join(" ")}`,
    execArgv: ["/usr/bin/sudo", "-k", "-A", "--", "rm", "-f", ...long],
    cwd: "/",
    surface: "studio",
    requester: "e2e",
    why: "layout check",
    timeoutMs: 120_000,
    passwordVia: "askpass",
    lines: [
      "PRIVILEGED COMMAND — approve this exact command, once?",
      `  sudo rm -f ${long.join(" ")}`,
      `runs: /usr/bin/sudo -k -A -- rm -f ${long.join(" ")}`,
      "in:       /",
    ],
  };
  await app.evaluate(({ BrowserWindow }, v) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("privileged:request", v);
  }, view);
  const dialog = page.getByRole("alertdialog", { name: "Approve a privileged command" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole("heading")).toBeInViewport();
  await expect(dialog.locator("code").first()).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Deny", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Approve once" })).toBeInViewport();
  await shoot("disk-05-long-command");
  await dialog.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});

test("the root terminal window: display only — its page has no way to send a key", async () => {
  // A real session needs the human's password, so the window's PAGE is rendered here on its own,
  // fed screen bytes the way main feeds it (after the page says it listens). Its keys are main's
  // business (before-input-event in root-terminal-window.ts, unit-tested); what this pins is
  // that the page draws the root program's screen and exposes no input path at all.
  const { app } = launched;
  const out = join(process.cwd(), "out");
  const title = "disk-space — running as administrator (root) [e2e]";
  const [root] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(
      async ({ BrowserWindow }, p) => {
        const w = new BrowserWindow({
          width: 1100,
          height: 640,
          title: p.title,
          webPreferences: {
            preload: p.preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        await w.loadFile(p.html);
      },
      {
        title,
        preload: join(out, "preload", "index.cjs"),
        html: join(out, "renderer", "admin-terminal.html"),
      },
    ),
  ]);
  await expect(root.getByText("Running as administrator (root)")).toBeVisible({ timeout: 15_000 });
  await app.evaluate(
    ({ BrowserWindow }, p) => {
      // by URL: the page's own <title> replaces the window title once it loads
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().endsWith("/admin-terminal.html"),
      );
      w?.webContents.send("disk:adminData", p.screen);
    },
    {
      screen: [
        "\x1b[2J\x1b[H\x1b[1;37;41m disk_space 2.0.0 · map of / · running as root \x1b[0m\r\n\r\n",
        "  \x1b[1m/\x1b[0m  460.4G  (412 folders, 0 unreadable)\r\n",
        "  ├─ \x1b[36mSystem\x1b[0m        212.8G  46.2%  \x1b[44m              \x1b[0m\r\n",
        "  ├─ \x1b[36mUsers\x1b[0m         173.1G  37.6%  \x1b[44m           \x1b[0m\r\n",
        "  ├─ \x1b[36mprivate\x1b[0m        41.7G   9.1%  \x1b[44m   \x1b[0m\r\n",
        "  └─ \x1b[36mLibrary\x1b[0m        19.9G   4.3%  \x1b[44m \x1b[0m\r\n\r\n",
        "  ↑↓ move  ⏎ open  d delete  q quit\r\n",
      ].join(""),
    },
  );
  await expect(root.locator(".xterm-rows")).toContainText("running as root", { timeout: 10_000 });
  const inputPath = await root.evaluate(() => {
    const api = (window as unknown as { prometheus: { diskSpace: Record<string, unknown> } })
      .prometheus.diskSpace;
    return Object.keys(api).filter((k) => /input|write|type|send/i.test(k));
  });
  assert.deepEqual(inputPath, [], "the bridge offers no way to type into root");
  await root.waitForTimeout(600);
  await root.screenshot({ path: join(SHOTS, "disk-06-root-window.png") });
  await root.close();
});
