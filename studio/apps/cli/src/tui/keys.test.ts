/**
 * keys.test.ts — raw escape-sequence decoding: arrows, control bytes, paste, split
 * sequences (rest buffer), UTF-8 code points.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BINDINGS, decodeKeys, remapKey, renderKeymap, resolveKeymap } from "./keys.js";

const names = (s: string): string[] => decodeKeys(s).events.map((e) => e.name);

test("printable chars decode one per code point", () => {
  const { events, rest } = decodeKeys("abc");
  assert.deepEqual(
    events.map((e) => e.ch),
    ["a", "b", "c"],
  );
  assert.equal(rest, "");
});

test("UTF-8 astral code point stays one char event", () => {
  const { events } = decodeKeys("a😀b");
  assert.deepEqual(
    events.map((e) => e.ch),
    ["a", "😀", "b"],
  );
});

test("arrows + home/end + delete decode", () => {
  assert.deepEqual(names("\x1b[A\x1b[B\x1b[C\x1b[D"), ["up", "down", "right", "left"]);
  assert.deepEqual(names("\x1b[H\x1b[F"), ["home", "end"]);
  assert.deepEqual(names("\x1b[1~\x1b[4~\x1b[3~"), ["home", "end", "delete"]);
  assert.deepEqual(names("\x1bOA\x1bOD"), ["up", "left"]); // application cursor mode
});

test("Shift-Tab (ESC[Z) → backtab; Tab → tab", () => {
  assert.deepEqual(names("\t\x1b[Z"), ["tab", "backtab"]);
});

test("control bytes map (enter/backspace/ctrl-c/ctrl-d/ctrl-l)", () => {
  assert.deepEqual(names("\r"), ["enter"]);
  assert.deepEqual(names("\x7f"), ["backspace"]);
  assert.deepEqual(names("\x03\x04\x0c"), ["ctrl-c", "ctrl-d", "ctrl-l"]);
});

test("alt/shift-enter → newline (multi-line composer)", () => {
  assert.deepEqual(names("\x1b\r"), ["newline"]);
});

test("CR(0x0D)=enter, LF(0x0A=Ctrl-J)=newline (raw-mode disambiguation)", () => {
  assert.deepEqual(names("\r"), ["enter"]);
  assert.deepEqual(names("\n"), ["newline"]);
});

test("Ctrl/Alt-arrow → word motion", () => {
  assert.deepEqual(names("\x1b[1;5C\x1b[1;5D"), ["word-right", "word-left"]);
});

test("bracketed paste collapses to one paste event", () => {
  const { events } = decodeKeys("\x1b[200~hello\nworld\x1b[201~");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.name, "paste");
  assert.equal(events[0]?.ch, "hello\nworld");
});

test("paste split across reads is held in rest until complete", () => {
  const first = decodeKeys("x\x1b[200~par");
  assert.deepEqual(
    first.events.map((e) => e.name),
    ["char"],
  );
  assert.equal(first.rest, "\x1b[200~par");
  const second = decodeKeys(`${first.rest}tial\x1b[201~`);
  assert.equal(second.events[0]?.name, "paste");
  assert.equal(second.events[0]?.ch, "partial");
  assert.equal(second.rest, "");
});

test("split CSI (ESC then [A) is reassembled via rest", () => {
  const a = decodeKeys("ab\x1b");
  assert.equal(a.rest, "\x1b");
  assert.deepEqual(
    a.events.map((e) => e.name),
    ["char", "char"],
  );
  const b = decodeKeys(`${a.rest}[A`);
  assert.deepEqual(
    b.events.map((e) => e.name),
    ["up"],
  );
});

test("a bare ESC followed by a normal char is the Esc key", () => {
  assert.deepEqual(names("\x1bx"), ["esc", "char"]);
});

test("decodeKeys: Ctrl-T (\\x14) → ctrl-t (CLI-018)", () => {
  assert.deepEqual(names("\x14"), ["ctrl-t"]);
});

test("decodeKeys: Ctrl-G (\\x07) → ctrl-g, Ctrl-S (\\x13) → ctrl-s (CLI-067)", () => {
  assert.deepEqual(names("\x07"), ["ctrl-g"]);
  assert.deepEqual(names("\x13"), ["ctrl-s"]);
  // interleaved with text decodes cleanly (no swallowing).
  assert.deepEqual(names("a\x07b\x13c"), ["char", "ctrl-g", "char", "ctrl-s", "char"]);
});

test("decodeKeys: Ctrl-Y (\\x19) → ctrl-y (CLI-068)", () => {
  assert.deepEqual(names("\x19"), ["ctrl-y"]);
});

// ── CLI-069: SGR mouse decode ────────────────────────────────────────────────────
test("decodeKeys: SGR mouse press/release/wheel decode (CLI-069)", () => {
  const one = (s: string) => decodeKeys(s).events[0];
  assert.deepEqual(one("\x1b[<0;10;5M"), {
    name: "mouse",
    mouse: { button: 0, x: 10, y: 5, pressed: true },
  });
  assert.deepEqual(one("\x1b[<0;10;5m"), {
    name: "mouse",
    mouse: { button: 0, x: 10, y: 5, pressed: false },
  });
  assert.deepEqual(one("\x1b[<64;1;1M"), {
    name: "mouse",
    mouse: { button: 0, x: 1, y: 1, pressed: true, wheel: "up" },
  });
  // cb=65 → wheel-down; low 2 bits (65 & 3) = 1 (button field is unused for wheel).
  assert.deepEqual(one("\x1b[<65;1;1M"), {
    name: "mouse",
    mouse: { button: 1, x: 1, y: 1, pressed: true, wheel: "down" },
  });
  // right button (cb=2): low 2 bits = 2.
  assert.equal(one("\x1b[<2;3;4M")?.mouse?.button, 2);
});

test("decodeKeys: a split mouse report buffers until the final M/m (CLI-069)", () => {
  const first = decodeKeys("\x1b[<0;10;5"); // no final byte yet
  assert.deepEqual(first.events, []);
  assert.equal(first.rest, "\x1b[<0;10;5"); // held for the next read
  const second = decodeKeys(`${first.rest}M`);
  assert.deepEqual(second.events, [
    { name: "mouse", mouse: { button: 0, x: 10, y: 5, pressed: true } },
  ]);
});

/* ── CLI-096: keymap resolution + remap + render ─────────────────────────────────── */

test("resolveKeymap: no config → all defaults, ok, identity remap (CLI-096)", () => {
  const r = resolveKeymap(undefined);
  assert.equal(r.ok, true);
  assert.equal(r.bindings.send, "enter");
  assert.equal(r.sources.send, "default");
  assert.equal(remapKey(r, "enter"), "enter"); // identity for defaults
});

test("resolveKeymap: a valid rebind applies + marks source user; remap → the action's default key (CLI-096)", () => {
  const r = resolveKeymap({ "history-prev": "pageup" }); // pageup is a free key
  assert.equal(r.ok, true);
  assert.equal(r.bindings["history-prev"], "pageup");
  assert.equal(r.sources["history-prev"], "user");
  // the physical rebound key translates to the action's canonical default key (up) for the switch.
  assert.equal(remapKey(r, "pageup"), DEFAULT_BINDINGS["history-prev"]);
  assert.equal(remapKey(r, "pageup"), "up");
});

test("resolveKeymap: a CONFLICT (two actions → one key) refuses + names both, falls back (CLI-096)", () => {
  // bind clear-line onto ctrl-k, which is clear-to-eol's default → both map to ctrl-k.
  const r = resolveKeymap({ "clear-line": "ctrl-k" });
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /ctrl-k/.test(e) && /clear-line/.test(e) && /clear-to-eol/.test(e)),
  );
  // refused ⇒ defaults in effect (never a silent partial load).
  assert.equal(r.bindings["clear-line"], "ctrl-u");
});

test("resolveKeymap: reserved keys/actions cannot be rebound — a NAMED error (CLI-096)", () => {
  const toKey = resolveKeymap({ "toggle-tools": "ctrl-c" }); // binding TO a reserved key
  assert.equal(toKey.ok, false);
  assert.ok(toKey.errors.some((e) => /reserved key 'ctrl-c'/.test(e) && /toggle-tools/.test(e)));
  const reservedAction = resolveKeymap({ cancel: "ctrl-x" }); // moving a reserved action
  assert.equal(reservedAction.ok, false);
  assert.ok(reservedAction.errors.some((e) => /reserved action 'cancel'/.test(e)));
});

test("resolveKeymap: unknown action/key → skip + warning, keep default (deliverable 5) (CLI-096)", () => {
  const r = resolveKeymap({ bogus: "ctrl-t", send: "not-a-key" });
  assert.equal(r.ok, true); // warnings are non-fatal
  assert.ok(r.warnings.some((w) => /unknown action 'bogus'/.test(w)));
  assert.ok(r.warnings.some((w) => /unknown key 'not-a-key'/.test(w)));
  assert.equal(r.bindings.send, "enter"); // kept the default
});

test("resolveKeymap: a control-key alias (ctrl-m == enter) is normalized + warned (CLI-096)", () => {
  // ctrl-m is the same byte as enter → binding newline to it conflicts with send(enter).
  const r = resolveKeymap({ newline: "ctrl-m" });
  assert.ok(r.warnings.some((w) => /alias of 'enter'/.test(w)));
});

test("renderKeymap: one line per action with source; reserved footer; refused leads with errors (CLI-096)", () => {
  const ok = renderKeymap(resolveKeymap({ "history-prev": "pageup" })).join("\n");
  assert.match(ok, /pageup\s+history-prev\s+\(user \*\)/);
  assert.match(ok, /enter\s+send\s+\(default\)/);
  assert.match(ok, /reserved \(unbindable\): ctrl-c, esc/);
  const refused = renderKeymap(resolveKeymap({ "clear-line": "ctrl-k" })).join("\n");
  assert.match(refused, /REFUSED/);
  assert.match(refused, /clear-line/);
});
