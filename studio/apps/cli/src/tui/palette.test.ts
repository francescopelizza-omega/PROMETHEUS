/**
 * palette.test.ts — capability detection, token-sourced truecolor paint, 256
 * downsample, gradient, and the high-contrast selection bar.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectColorCaps,
  gradientStops,
  hexToRgb,
  paint,
  painter,
  rgbTo256,
  selectionBar,
} from "./palette.js";

test("detectColorCaps reads env depth + honors the global enable switch", () => {
  assert.equal(detectColorCaps({ COLORTERM: "truecolor", TERM: "xterm-256color" }), "truecolor");
  assert.equal(detectColorCaps({ TERM: "xterm-256color" }), "ansi256");
  assert.equal(detectColorCaps({ TERM: "xterm" }), "ansi16");
  assert.equal(detectColorCaps({ TERM: "dumb" }), "none");
  assert.equal(detectColorCaps({ NO_COLOR: "1", COLORTERM: "truecolor" }), "none");
  assert.equal(detectColorCaps({ FORCE_COLOR: "0", COLORTERM: "truecolor" }), "none");
  // the global switch (enabled=false) wins over everything
  assert.equal(detectColorCaps({ COLORTERM: "truecolor" }, false), "none");
});

test("hexToRgb parses token hex", () => {
  assert.deepEqual(hexToRgb("#5cdff5"), { r: 92, g: 223, b: 245 });
  assert.deepEqual(hexToRgb("#000000"), { r: 0, g: 0, b: 0 });
});

test("rgbTo256 maps black/white to the cube extremes", () => {
  assert.equal(rgbTo256({ r: 0, g: 0, b: 0 }), 16);
  assert.equal(rgbTo256({ r: 255, g: 255, b: 255 }), 231);
});

test("paint: none passes through; a ramp role emits 38;2;r;g;b from the token ramp", () => {
  // 'command' == violet.300 (a non-accent ramp role) keeps the plain ramp behavior.
  assert.equal(paint("hi", "command", "none"), "hi");
  assert.match(paint("x", "command", "truecolor"), /^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[0m$/);
  assert.equal(
    paint("x", "command", "truecolor", { bold: true }),
    paint("x", "command", "truecolor").replace("\x1b[", "\x1b[1;"),
  );
  // 256 path emits 38;5;<idx>, no forced bold for a ramp role.
  assert.match(paint("x", "command", "ansi256"), /^\x1b\[38;5;\d+mx\x1b\[0m$/);
});

test("paint: light-blue roles are pinned to the bold accent #16b3f5 (22,179,245)", () => {
  // accent/info/question all render the operator accent and are ALWAYS bold.
  for (const role of ["accent", "info", "question"] as const) {
    assert.equal(paint("x", role, "truecolor"), "\x1b[1;38;2;22;179;245mx\x1b[0m", role);
    // ansi16 fallback keeps the role's cyan (36) / brightCyan (96) but stays bold
    assert.match(paint("x", role, "ansi16"), /^\x1b\[1;(36|96)mx\x1b\[0m$/, role);
    // 256 path also bold
    assert.match(paint("x", role, "ansi256"), /^\x1b\[1;38;5;\d+mx\x1b\[0m$/, role);
    assert.equal(paint("x", role, "none"), "x");
  }
});

test("painter binds a terse role->fn set", () => {
  const p = painter("truecolor");
  assert.equal(p.codeAdd("+1"), paint("+1", "codeAdd", "truecolor"));
  assert.equal(p.bold("T", "heading"), paint("T", "heading", "truecolor", { bold: true }));
});

test("gradientStops interpolates inclusive endpoints", () => {
  const s = gradientStops({ r: 0, g: 0, b: 0 }, { r: 10, g: 20, b: 30 }, 3);
  assert.deepEqual(s[0], { r: 0, g: 0, b: 0 });
  assert.deepEqual(s[2], { r: 10, g: 20, b: 30 });
  assert.deepEqual(s[1], { r: 5, g: 10, b: 15 });
});

test("selectionBar: none → plain marker, ansi16 → reverse video, truecolor → bg gradient", () => {
  assert.equal(selectionBar("run", 6, "none"), "› run");
  assert.equal(selectionBar("run", 5, "ansi16"), "\x1b[7mrun  \x1b[0m");
  const tc = selectionBar("run", 5, "truecolor");
  assert.match(tc, /48;2;/); // a background gradient is present
  assert.ok(tc.endsWith("\x1b[0m"));
});

test("rgbTo256: a pure-255 non-gray channel stays in the 16..231 color cube (no grayscale overflow)", () => {
  // toCube(255)=round(5.5)=6 would overflow the 0..5 axis into the grayscale ramp (232..255).
  const idx = rgbTo256({ r: 255, g: 100, b: 100 });
  assert.ok(idx >= 16 && idx <= 231, `expected a cube index 16..231, got ${idx}`);
  assert.ok(rgbTo256({ r: 255, g: 0, b: 255 }) <= 231);
});
