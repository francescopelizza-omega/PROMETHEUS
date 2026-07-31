/**
 * gutter-decorations.test.ts — node:test for the PURE glyph-margin registry (APP-011).
 *
 * Pins the register/unregister lifecycle (unregister sweeps every decoration the
 * provider owns), per-line add/remove, replaceForProvider idempotence, the
 * deterministic multi-provider same-line precedence (order, then providerId), the
 * glyph-margin mouse filtering, and click/hover dispatch to subscribers. Pure —
 * runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GUTTER_GLYPH_MARGIN,
  type GutterDecorationInput,
  type GutterMouseEvent,
  type GutterState,
  addDecoration,
  createGutterRegistry,
  decorationsForFile,
  gutterEventFromMouse,
  initialGutterState,
  registerProvider,
  removeDecoration,
  replaceForProvider,
  unregisterProvider,
} from "./gutter-decorations.js";

const FILE = "file:///a.py";

function dec(line: number, glyph = "glyph-x", order = 10, hover?: string): GutterDecorationInput {
  return { line, glyphClassName: glyph, order, ...(hover ? { hoverMessage: hover } : {}) };
}

test("registerProvider is idempotent (re-register is a same-ref no-op)", () => {
  const s1 = registerProvider(initialGutterState(), "bp");
  assert.equal(registerProvider(s1, "bp"), s1);
});

test("addDecoration on an UNregistered provider is a same-ref no-op (lifecycle contract)", () => {
  const s = initialGutterState();
  assert.equal(addDecoration(s, "ghost", FILE, dec(1)), s);
});

test("addDecoration stores per-line; a second add on the same line replaces it", () => {
  let s = registerProvider(initialGutterState(), "bp");
  s = addDecoration(s, "bp", FILE, dec(3, "glyph-a"));
  s = addDecoration(s, "bp", FILE, dec(3, "glyph-b"));
  const views = decorationsForFile(s, FILE);
  assert.equal(views.length, 1);
  assert.equal(views[0]?.glyphClassName, "glyph-b");
});

test("removeDecoration drops one line; removing an absent line is a same-ref no-op", () => {
  let s = registerProvider(initialGutterState(), "bp");
  s = addDecoration(s, "bp", FILE, dec(3));
  s = addDecoration(s, "bp", FILE, dec(7));
  const removed = removeDecoration(s, "bp", FILE, 3);
  assert.deepEqual(
    decorationsForFile(removed, FILE).map((v) => v.line),
    [7],
  );
  assert.equal(removeDecoration(removed, "bp", FILE, 99), removed);
});

test("unregisterProvider removes ALL of that provider's decorations from state", () => {
  let s = registerProvider(initialGutterState(), "bp");
  s = registerProvider(s, "cov");
  s = addDecoration(s, "bp", FILE, dec(1));
  s = addDecoration(s, "bp", "file:///b.py", dec(2));
  s = addDecoration(s, "cov", FILE, dec(1, "glyph-cov"));
  s = unregisterProvider(s, "bp");
  assert.equal("bp" in s, false);
  assert.deepEqual(
    decorationsForFile(s, FILE).flatMap((v) => v.providerIds),
    ["cov"],
  );
  assert.deepEqual(decorationsForFile(s, "file:///b.py"), []);
});

test("replaceForProvider replaces the whole per-file set and is idempotent (same-ref)", () => {
  let s = registerProvider(initialGutterState(), "bp");
  s = addDecoration(s, "bp", FILE, dec(1));
  const decs = [dec(4, "glyph-a", 5, "hover"), dec(9, "glyph-b", 5)];
  s = replaceForProvider(s, "bp", FILE, decs);
  assert.deepEqual(
    decorationsForFile(s, FILE).map((v) => v.line),
    [4, 9],
  );
  assert.equal(replaceForProvider(s, "bp", FILE, decs), s); // replay = same ref
  const cleared = replaceForProvider(s, "bp", FILE, []);
  assert.deepEqual(decorationsForFile(cleared, FILE), []);
  assert.equal(replaceForProvider(cleared, "bp", FILE, []), cleared);
});

test("two providers on one line: lowest order wins the glyph, hovers stack in order", () => {
  let s = registerProvider(initialGutterState(), "bp");
  s = registerProvider(s, "cov");
  s = addDecoration(s, "cov", FILE, dec(5, "glyph-cov", 20, "covered"));
  s = addDecoration(s, "bp", FILE, dec(5, "glyph-bp", 10, "breakpoint"));
  const [view] = decorationsForFile(s, FILE);
  assert.equal(view?.glyphClassName, "glyph-bp");
  assert.deepEqual(view?.hoverMessages, ["breakpoint", "covered"]);
  assert.deepEqual(view?.providerIds, ["bp", "cov"]);
});

test("equal order falls back to providerId (deterministic tie-break)", () => {
  let s = registerProvider(initialGutterState(), "zeta");
  s = registerProvider(s, "alpha");
  s = addDecoration(s, "zeta", FILE, dec(5, "glyph-z", 10));
  s = addDecoration(s, "alpha", FILE, dec(5, "glyph-a", 10));
  assert.equal(decorationsForFile(s, FILE)[0]?.glyphClassName, "glyph-a");
});

test("decorationsForFile sorts lines ascending and scopes to the path", () => {
  let s = registerProvider(initialGutterState(), "bp");
  s = addDecoration(s, "bp", FILE, dec(9));
  s = addDecoration(s, "bp", FILE, dec(2));
  s = addDecoration(s, "bp", "file:///other.py", dec(1));
  assert.deepEqual(
    decorationsForFile(s, FILE).map((v) => v.line),
    [2, 9],
  );
});

test("gutterEventFromMouse filters to the glyph margin and null-guards the position", () => {
  let s: GutterState = registerProvider(initialGutterState(), "bp");
  s = addDecoration(s, "bp", FILE, dec(3));
  const hit = gutterEventFromMouse(
    { target: { type: GUTTER_GLYPH_MARGIN, position: { lineNumber: 3 } } },
    FILE,
    s,
  );
  assert.deepEqual(hit, { path: FILE, line: 3, providerId: "bp" });
  // an undecorated line still emits (APP-012 hears "add a breakpoint here") — no providerId.
  assert.deepEqual(
    gutterEventFromMouse(
      { target: { type: GUTTER_GLYPH_MARGIN, position: { lineNumber: 8 } } },
      FILE,
      s,
    ),
    { path: FILE, line: 8 },
  );
  // GUTTER_LINE_NUMBERS (3) and a null position (empty margin) are filtered out.
  assert.equal(
    gutterEventFromMouse({ target: { type: 3, position: { lineNumber: 3 } } }, FILE, s),
    null,
  );
  assert.equal(
    gutterEventFromMouse({ target: { type: GUTTER_GLYPH_MARGIN, position: null } }, FILE, s),
    null,
  );
});

test("registry: subscribe fires on real changes only; unsubscribe stops it", () => {
  const reg = createGutterRegistry();
  let fired = 0;
  const un = reg.subscribe(() => {
    fired += 1;
  });
  reg.register("bp");
  assert.equal(fired, 1);
  reg.register("bp"); // same-ref no-op — no notify
  assert.equal(fired, 1);
  reg.add("bp", FILE, dec(1));
  assert.equal(fired, 2);
  reg.remove("bp", FILE, 99); // absent line — no notify
  assert.equal(fired, 2);
  un();
  reg.add("bp", FILE, dec(2));
  assert.equal(fired, 2);
});

test("registry: unregister sweeps state and notifies (editor re-sync path)", () => {
  const reg = createGutterRegistry();
  reg.register("bp");
  reg.add("bp", FILE, dec(1));
  let fired = 0;
  reg.subscribe(() => {
    fired += 1;
  });
  reg.unregister("bp");
  assert.equal(fired, 1);
  assert.deepEqual(reg.decorationsForFile(FILE), []);
});

test("registry: a glyph-margin click dispatches to the matching subscriber", () => {
  const reg = createGutterRegistry();
  reg.register("bp");
  reg.add("bp", FILE, dec(3));
  const seen: GutterMouseEvent[] = [];
  const un = reg.onGutterClick((e) => seen.push(e));
  const ev = gutterEventFromMouse(
    { target: { type: GUTTER_GLYPH_MARGIN, position: { lineNumber: 3 } } },
    FILE,
    reg.getState(),
  );
  assert.ok(ev);
  reg.emitClick(ev);
  assert.deepEqual(seen, [{ path: FILE, line: 3, providerId: "bp" }]);
  un();
  reg.emitClick(ev);
  assert.equal(seen.length, 1);
});

test("registry: hover dispatch dedupes by path+line (onMouseMove fires per-pixel)", () => {
  const reg = createGutterRegistry();
  const seen: number[] = [];
  reg.onGutterHover((e) => seen.push(e.line));
  reg.emitHover({ path: FILE, line: 4 });
  reg.emitHover({ path: FILE, line: 4 }); // same line — deduped
  reg.emitHover({ path: FILE, line: 5 });
  reg.emitHover({ path: "file:///b.py", line: 5 }); // same line, other file — dispatches
  assert.deepEqual(seen, [4, 5, 5]);
});

test("registry: clearHover resets the dedupe (leaving the margin re-arms a re-hover)", () => {
  const reg = createGutterRegistry();
  const seen: number[] = [];
  reg.onGutterHover((e) => seen.push(e.line));
  reg.emitHover({ path: FILE, line: 4 });
  reg.emitHover({ path: FILE, line: 4 }); // deduped
  reg.clearHover(); // pointer left the glyph margin
  reg.emitHover({ path: FILE, line: 4 }); // re-hover of the SAME line re-emits
  assert.deepEqual(seen, [4, 4]);
});
