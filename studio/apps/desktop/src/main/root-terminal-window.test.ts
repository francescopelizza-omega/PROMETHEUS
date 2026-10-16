// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * root-terminal-window.test.ts — the window a root program is shown in takes its keys from the
 * keyboard (before-input-event) and from nowhere else, and its page never sees them.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRootTerminalWindowOpener } from "./root-terminal-window.js";
import type { KeyInput } from "./terminal-keys.js";

function fakeWindow() {
  const wc = Object.assign(new EventEmitter(), {
    id: 42,
    sent: [] as [string, unknown][],
    send(ch: string, payload: unknown) {
      this.sent.push([ch, payload]);
    },
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: wc,
    destroyed: false,
    shown: "" as "" | "inactive" | "active",
    focused: 0,
    isDestroyed() {
      return this.destroyed;
    },
    showInactive() {
      this.shown = "inactive";
    },
    show() {
      this.shown = "active";
    },
    focus() {
      this.focused++;
    },
    close() {
      this.destroyed = true;
      this.emit("closed");
    },
  });
  return win;
}

function open() {
  const win = fakeWindow();
  const keys: KeyInput[] = [];
  let closed = 0;
  const opener = createRootTerminalWindowOpener({ createWindow: () => win as never });
  const handle = opener({ onKey: (k) => keys.push(k), onClosed: () => closed++ });
  return { win, keys, handle, closed: () => closed };
}

const key = (over: Partial<KeyInput>) => ({
  type: "keyDown",
  key: "a",
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...over,
});

test("a key pressed in the window goes to main's handler, and the page never receives it", () => {
  const { win, keys } = open();
  let prevented = false;
  win.webContents.emit(
    "before-input-event",
    { preventDefault: () => (prevented = true) },
    key({ key: "q" }),
  );
  assert.equal(keys[0]?.key, "q");
  assert.equal(prevented, true, "the page's keydown is suppressed: only main decides");
});

test("Cmd combinations stay the app's (menu shortcuts), key-ups are ignored", () => {
  const { win, keys } = open();
  let prevented = false;
  win.webContents.emit(
    "before-input-event",
    { preventDefault: () => (prevented = true) },
    key({ key: "w", meta: true }),
  );
  win.webContents.emit("before-input-event", { preventDefault: () => {} }, key({ type: "keyUp" }));
  assert.equal(keys.length, 0);
  assert.equal(prevented, false);
});

test("it opens without taking focus (the system password dialog is up), and focuses on demand", () => {
  const { win, handle } = open();
  win.emit("ready-to-show");
  assert.equal(win.shown, "inactive");
  handle.focus();
  assert.equal(win.shown, "active");
  assert.equal(win.focused, 1);
});

test("output sent before the page is listening is delivered once it says so, in order", () => {
  // did-finish-load is not enough: the page subscribes only after React mounts, so the program's
  // first screen used to be dropped. The page now says when it listens (adminReady).
  const { win, handle } = open();
  handle.status("Enter your password…");
  handle.data("A");
  win.webContents.emit("did-finish-load");
  assert.deepEqual(win.webContents.sent, []);
  handle.ready();
  handle.data("B");
  assert.deepEqual(
    win.webContents.sent.map(([, p]) => p),
    ["Enter your password…", "A", "B"],
  );
});

test("the human closing the window ends the session; the session closing it does not loop", () => {
  const a = open();
  a.win.close();
  assert.equal(a.closed(), 1);
  const b = open();
  b.handle.close();
  assert.equal(b.closed(), 0);
  assert.doesNotThrow(() => b.handle.data("late"), "a closed window ignores late output");
});

test("the handle names the window's webContents (resize and Stop are accepted from it only)", () => {
  assert.equal(open().handle.webContentsId, 42);
});
