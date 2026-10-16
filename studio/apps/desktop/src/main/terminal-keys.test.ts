// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * terminal-keys.test.ts — physical key presses (Electron's before-input-event) → the bytes a
 * terminal would send. The root terminal window takes its keys ONLY from here, so this table is
 * what a curses program running as root can receive.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cursorKeysMode, keyToTerminalBytes } from "./terminal-keys.js";

const k = (
  key: string,
  mods: Partial<Record<"control" | "alt" | "shift" | "meta", boolean>> = {},
) => ({
  type: "keyDown",
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods,
});

test("printable keys are their characters (shift is already in `key`)", () => {
  assert.equal(keyToTerminalBytes(k("q")), "q");
  assert.equal(keyToTerminalBytes(k("Q", { shift: true })), "Q");
  assert.equal(keyToTerminalBytes(k(" ")), " ");
  assert.equal(keyToTerminalBytes(k("è")), "è");
});

test("named keys become their VT sequences", () => {
  assert.equal(keyToTerminalBytes(k("Enter")), "\r");
  assert.equal(keyToTerminalBytes(k("Backspace")), "\x7f");
  assert.equal(keyToTerminalBytes(k("Tab")), "\t");
  assert.equal(keyToTerminalBytes(k("Tab", { shift: true })), "\x1b[Z");
  assert.equal(keyToTerminalBytes(k("Escape")), "\x1b");
  assert.equal(keyToTerminalBytes(k("Delete")), "\x1b[3~");
  assert.equal(keyToTerminalBytes(k("PageUp")), "\x1b[5~");
  assert.equal(keyToTerminalBytes(k("PageDown")), "\x1b[6~");
  assert.equal(keyToTerminalBytes(k("F1")), "\x1bOP");
  assert.equal(keyToTerminalBytes(k("F5")), "\x1b[15~");
});

test("cursor keys follow the program's cursor-key mode (curses turns application mode on)", () => {
  assert.equal(keyToTerminalBytes(k("ArrowUp")), "\x1b[A");
  assert.equal(keyToTerminalBytes(k("ArrowLeft")), "\x1b[D");
  assert.equal(keyToTerminalBytes(k("Home")), "\x1b[H");
  assert.equal(keyToTerminalBytes(k("ArrowUp"), { appCursor: true }), "\x1bOA");
  assert.equal(keyToTerminalBytes(k("End"), { appCursor: true }), "\x1bOF");
});

test("Ctrl+letter is its control code; Ctrl+D is 0x04, Ctrl+] 0x1d", () => {
  assert.equal(keyToTerminalBytes(k("c", { control: true })), "\x03");
  assert.equal(keyToTerminalBytes(k("d", { control: true })), "\x04");
  assert.equal(keyToTerminalBytes(k("D", { control: true, shift: true })), "\x04");
  assert.equal(keyToTerminalBytes(k("]", { control: true })), "\x1d");
  assert.equal(keyToTerminalBytes(k("[", { control: true })), "\x1b");
});

test("Alt+ASCII is ESC-prefixed (meta); a macOS Option character is sent as the character", () => {
  assert.equal(keyToTerminalBytes(k("f", { alt: true })), "\x1bf");
  assert.equal(keyToTerminalBytes(k("å", { alt: true })), "å");
});

test("Cmd combos, lone modifiers and key-ups send nothing (menu shortcuts stay the app's)", () => {
  assert.equal(keyToTerminalBytes(k("w", { meta: true })), null);
  assert.equal(keyToTerminalBytes(k("Shift", { shift: true })), null);
  assert.equal(keyToTerminalBytes(k("Control", { control: true })), null);
  assert.equal(keyToTerminalBytes(k("CapsLock")), null);
  assert.equal(keyToTerminalBytes({ ...k("q"), type: "keyUp" }), null);
});

test("cursorKeysMode tracks DECCKM from the program's output, across a split chunk", () => {
  let s = cursorKeysMode({ appCursor: false, tail: "" }, "\x1b[?1h");
  assert.equal(s.appCursor, true);
  s = cursorKeysMode(s, "text\x1b[?");
  s = cursorKeysMode(s, "1l");
  assert.equal(s.appCursor, false);
  s = cursorKeysMode(s, "\x1b[?1049h\x1b[?1;1000h");
  assert.equal(s.appCursor, true);
});
