/**
 * palette.test.ts — capability detection, token-sourced truecolor paint, 256
 * downsample, gradient, and the high-contrast selection bar.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectColorCaps,
  durationTier,
  gradientStops,
  hexToRgb,
  paint,
  paintDuration,
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

/* ── the elapsed-turn clock ────────────────────────────────────────────────── */

const MIN = 60_000;
const HR = 3_600_000;

test("durationTier: every band is [lower, upper) — the boundary belongs to the SLOWER band", () => {
  assert.equal(durationTier(0), "lt30m");
  assert.equal(durationTier(29 * MIN + 59_999), "lt30m");
  assert.equal(durationTier(30 * MIN), "lt1h"); // exactly 30m has left the fast band
  assert.equal(durationTier(59 * MIN), "lt1h");
  assert.equal(durationTier(1 * HR), "lt2h");
  assert.equal(durationTier(2 * HR - 1), "lt2h");
  assert.equal(durationTier(2 * HR), "lt3h");
  assert.equal(durationTier(3 * HR - 1), "lt3h");
  assert.equal(durationTier(3 * HR), "lt5h");
  assert.equal(durationTier(5 * HR - 1), "lt5h");
  assert.equal(durationTier(5 * HR), "lt7h");
  assert.equal(durationTier(7 * HR - 1), "lt7h");
  assert.equal(durationTier(7 * HR), "gte7h");
  assert.equal(durationTier(400 * HR), "gte7h");
});

test("durationTier: a skewed/NaN span floors to the fast band instead of throwing", () => {
  assert.equal(durationTier(-5), "lt30m");
  assert.equal(durationTier(Number.NaN), "lt30m");
  assert.equal(durationTier(Number.POSITIVE_INFINITY), "lt30m");
});

test("paintDuration: ALWAYS bold, and the hue walks blue→green→yellow→orange→red→rubine→purple", () => {
  const at = (ms: number): string => paintDuration("⏱ x", ms, "truecolor");
  // every band is bold — the SGR opens with the bold parameter, not just a colour
  for (const ms of [0, 45 * MIN, 90 * MIN, 150 * MIN, 4 * HR, 6 * HR, 8 * HR]) {
    assert.match(at(ms), /^\x1b\[1;38;2;/, `not bold at ${ms}ms`);
  }
  // under 30m is the operator accent (#16b3f5), NOT the old neutral.500 grey (#727d8e)
  assert.ok(at(5_000).startsWith("\x1b[1;38;2;22;179;245m"));
  assert.ok(!at(5_000).includes("114;125;142"));
  // green.400 / amber.300 / red.400 / violet.400 come straight off the token ramps
  assert.ok(at(45 * MIN).startsWith("\x1b[1;38;2;52;196;106m"));
  assert.ok(at(90 * MIN).startsWith("\x1b[1;38;2;251;191;74m"));
  assert.ok(at(4 * HR).startsWith("\x1b[1;38;2;242;67;67m"));
  assert.ok(at(8 * HR).startsWith("\x1b[1;38;2;178;102;255m"));
  // all seven bands are visually DISTINCT at truecolor (an orange that equals the yellow, or a
  // rubine that equals the red, would make the whole scheme unreadable)
  const hues = [0, 45 * MIN, 90 * MIN, 150 * MIN, 4 * HR, 6 * HR, 8 * HR].map(at);
  assert.equal(new Set(hues).size, 7);
});

test("paintDuration: orange sits between yellow and red; rubine is DARKER than the red above it", () => {
  const rgb = (ms: number): number[] => {
    const m = /38;2;(\d+);(\d+);(\d+)m/.exec(paintDuration("x", ms, "truecolor"));
    assert.ok(m, "no truecolor triple");
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [, yG] = rgb(90 * MIN) as [number, number, number];
  const [, oG] = rgb(150 * MIN) as [number, number, number];
  const [, rG] = rgb(4 * HR) as [number, number, number];
  assert.ok(oG < yG && oG > rG, `orange green-channel ${oG} not between ${yG} and ${rG}`);
  const lum = (c: number[]): number =>
    0.299 * (c[0] ?? 0) + 0.587 * (c[1] ?? 0) + 0.114 * (c[2] ?? 0);
  assert.ok(lum(rgb(6 * HR)) < lum(rgb(4 * HR)), "rubine is not darker than the bright red");
});

test("paintDuration: ansi16 keeps the sweep, caps='none' emits ZERO escape bytes", () => {
  assert.equal(paintDuration("⏱ 8h", 8 * HR, "none"), "⏱ 8h");
  assert.ok(!paintDuration("⏱ 8h", 8 * HR, "none").includes("\x1b"));
  const a16 = (ms: number): string => paintDuration("x", ms, "ansi16");
  for (const ms of [0, 45 * MIN, 8 * HR]) assert.match(a16(ms), /^\x1b\[1;\d+m/);
  // cyan → green → magenta survives the downgrade even where adjacent warm bands collapse
  assert.notEqual(a16(0), a16(45 * MIN));
  assert.notEqual(a16(45 * MIN), a16(8 * HR));
  assert.notEqual(a16(0), a16(8 * HR));
});

test("paintDuration: ansi256 downsamples rather than emitting a truecolor triple", () => {
  const out = paintDuration("x", 6 * HR, "ansi256");
  assert.match(out, /^\x1b\[1;38;5;\d+m/);
});
