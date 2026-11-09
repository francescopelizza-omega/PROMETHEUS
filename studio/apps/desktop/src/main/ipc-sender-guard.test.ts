// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { IPC } from "../shared/ipc-contract.js";
import {
  classifySenderUrl,
  installIpcSenderGuard,
  resetIpcSenderGuardForTests,
  senderMayUse,
  senderRefusal,
} from "./ipc-sender-guard.js";

const ROOT = "/Applications/Prometheus Studio.app/Contents/Resources/app.asar/out/renderer";
const prod = { rendererDirs: [ROOT] };
const page = (name: string) => pathToFileURL(`${ROOT}/${name}`).href;

test("packaged renderer pages are recognised, anything else is not", () => {
  assert.equal(classifySenderUrl(page("index.html"), prod), "workbench");
  assert.equal(classifySenderUrl(`${page("index.html")}#/models`, prod), "workbench");
  assert.equal(
    classifySenderUrl(`${page("floating-terminal.html")}?pty=1`, prod),
    "floating-terminal",
  );
  assert.equal(classifySenderUrl(page("admin-terminal.html"), prod), "admin-terminal");
  // the same tree spelled through .asar.unpacked
  assert.equal(
    classifySenderUrl(page("index.html").replace("app.asar", "app.asar.unpacked"), prod),
    "workbench",
  );
  assert.equal(classifySenderUrl(pathToFileURL("/tmp/index.html").href, prod), null);
  assert.equal(classifySenderUrl(page("../../evil.html"), prod), null);
  assert.equal(classifySenderUrl(page("other.html"), prod), null);
  assert.equal(classifySenderUrl("https://example.com/index.html", prod), null);
  assert.equal(classifySenderUrl("not a url", prod), null);
});

test("dev mode accepts only the dev server's exact origin", () => {
  const dev = { rendererDirs: [ROOT], devUrl: "http://localhost:5173" };
  assert.equal(classifySenderUrl("http://localhost:5173/", dev), "workbench");
  assert.equal(
    classifySenderUrl("http://localhost:5173/admin-terminal.html", dev),
    "admin-terminal",
  );
  assert.equal(classifySenderUrl("http://localhost:5173.evil.example/", dev), null);
  assert.equal(classifySenderUrl("http://localhost:5174/", dev), null);
  // a packaged file: page is not trusted while running against a dev server
  assert.equal(classifySenderUrl(page("index.html"), dev), null);
});

test("terminal windows reach only their own channels", () => {
  assert.equal(senderMayUse("workbench", IPC.idePtySpawn), true);
  assert.equal(senderMayUse("floating-terminal", IPC.idePtyWrite), true);
  assert.equal(senderMayUse("floating-terminal", IPC.idePtySpawn), false);
  assert.equal(senderMayUse("admin-terminal", IPC.diskAdminResize), true);
  // its Stop button (RootTerminalView) — dropping it left a root session unstoppable from there
  assert.equal(senderMayUse("admin-terminal", IPC.diskAdminStop), true);
  assert.equal(senderMayUse("admin-terminal", IPC.diskAdminReady), true);
  assert.equal(senderMayUse("floating-terminal", IPC.ideFloatingTerminalClose), true);
  assert.equal(senderMayUse("admin-terminal", IPC.idePtyWrite), false);
  assert.equal(senderMayUse("admin-terminal", IPC.settingsSet), false);
});

test("sub-frames and dead frames are refused", () => {
  const ok = { senderFrame: { url: page("index.html"), parent: null } };
  assert.equal(senderRefusal(IPC.settingsSet, ok, prod), null);
  assert.match(String(senderRefusal(IPC.settingsSet, { senderFrame: null }, prod)), /no longer/);
  assert.match(
    String(
      senderRefusal(
        IPC.settingsSet,
        { senderFrame: { url: page("index.html"), parent: {} } },
        prod,
      ),
    ),
    /sub-frame/,
  );
  assert.match(
    String(
      senderRefusal(
        IPC.settingsSet,
        { senderFrame: { url: page("admin-terminal.html"), parent: null } },
        prod,
      ),
    ),
    /may not use/,
  );
});

test("the installed guard wraps handlers registered after it", async () => {
  resetIpcSenderGuardForTests();
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const fake = {
    handle: (ch: string, l: (...a: unknown[]) => unknown) => void handlers.set(ch, l),
    on: (ch: string, l: (...a: unknown[]) => unknown) => void handlers.set(`on:${ch}`, l),
  };
  const logs: string[] = [];
  installIpcSenderGuard(fake as never, prod, (m) => logs.push(m));
  fake.handle(IPC.settingsSet, (_e: unknown, x: unknown) => `ran ${String(x)}`);
  fake.on(IPC.idePtyWrite, () => "sent");
  const good = { senderFrame: { url: page("index.html"), parent: null } };
  const admin = { senderFrame: { url: page("admin-terminal.html"), parent: null } };
  assert.equal(handlers.get(IPC.settingsSet)?.(good, 1), "ran 1");
  assert.throws(() => handlers.get(IPC.settingsSet)?.(admin, 1), /refused/);
  assert.equal(handlers.get(`on:${IPC.idePtyWrite}`)?.(admin), undefined);
  assert.equal(logs.length, 2);
  resetIpcSenderGuardForTests();
});
