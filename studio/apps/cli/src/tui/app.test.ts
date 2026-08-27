/**
 * app.test.ts — the modal repaint helper (CLI-064) + grapheme-aware modal editing (CLI-065). The
 * raw-TTY controller (app.ts) is exercised manually; the extractable pure units — `renderModal`,
 * `applyModalKey`, `modalCursorCol` — are the ones first-paint AND the SIGWINCH repaint route
 * through, so testing them proves the resize + editing behavior.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { agent } from "@prometheus/core";
import { resolveStartAuthLevel } from "./app.js";
import { type ModalView, applyModalKey, modalCursorCol, renderModal } from "./frame.js";
import { stringWidth } from "./width.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const WIDTHS = [40, 80, 120] as const;
const ask = (buffer: string, caret = 0): ModalView => ({
  kind: "ask",
  prompt: "value:",
  buffer,
  caret,
});
const key = (name: string, ch?: string): { name: string; ch?: string } =>
  ch ? { name, ch } : { name };

/* ── CLI-064: width-aware modal repaint ──────────────────────────────────────── */

test("confirm modal: prompt fully visible + [y/N] at 40/80/120, each line ≤ width (CLI-064)", () => {
  const modal: ModalView = {
    kind: "confirm",
    prompt: "run tool install with these arguments and cross the nemesis gate before any change?",
    buffer: "",
    caret: 0,
  };
  for (const w of WIDTHS) {
    const lines = renderModal(modal, w, "none").map(strip);
    const joined = lines.join(" ");
    for (const word of modal.prompt.split(/\s+/))
      assert.ok(joined.includes(word), `missing "${word}" @${w}`);
    assert.match(joined, /\[y\/N\]/);
    for (const line of lines)
      assert.ok(stringWidth(line) <= w, `line exceeds ${w}: ${JSON.stringify(line)}`);
  }
});

test("ask modal: typed buffer rendered + survives re-render at a new width; empty = 1 line (CLI-064)", () => {
  const typed = "my answer text that is fairly long to force a wrap on narrow terminals";
  const modal = ask(typed, 5);
  for (const w of [30, 80]) {
    const lines = renderModal(modal, w, "none").map(strip);
    const joined = lines.join(" ");
    for (const word of typed.split(/\s+/))
      assert.ok(joined.includes(word), `buffer word "${word}" lost @${w}`);
    for (const line of lines) assert.ok(stringWidth(line) <= w);
  }
  assert.deepEqual(renderModal(ask(""), 80, "none").map(strip), ["› value:"]);
});

/* ── CLI-065: grapheme-aware editing ─────────────────────────────────────────── */

test("backspace after 你好 deletes ONE char → 你, no half-cell residue (CLI-065)", () => {
  let m = ask("你好", 2); // caret at end (2 graphemes)
  m = applyModalKey(m, key("backspace"));
  assert.equal(m.buffer, "你");
  assert.equal(m.caret, 1);
  // the repaint renders the whole buffer (full-line repaint) → no debris; cursor is width-correct.
  assert.deepEqual(renderModal(m, 80, "none").map(strip), ["› value: 你"]);
  assert.equal(modalCursorCol(m), stringWidth("› value: 你")); // 2-cell 你 → column advanced by 2
});

test("backspace deletes a ZWJ family emoji as ONE unit (CLI-065)", () => {
  const family = "👨‍👩‍👧"; // 7 code points, 1 grapheme
  let m = ask(`ab${family}`, 3); // a, b, family = 3 graphemes
  m = applyModalKey(m, key("backspace"));
  assert.equal(m.buffer, "ab"); // whole cluster gone, not a fragment
  assert.equal(m.caret, 2);
});

test("home then typing prepends; left×2 then typing inserts mid-string (CLI-065)", () => {
  // home → caret 0 → type X prepends.
  let m = ask("abc", 3);
  m = applyModalKey(m, key("home"));
  assert.equal(m.caret, 0);
  m = applyModalKey(m, key("char", "X"));
  assert.equal(m.buffer, "Xabc");
  assert.equal(m.caret, 1);

  // end, then left×2, then type → mid-string insert.
  let n = ask("abcd", 4);
  n = applyModalKey(n, key("left"));
  n = applyModalKey(n, key("left")); // caret between b and c
  assert.equal(n.caret, 2);
  n = applyModalKey(n, key("char", "Z"));
  assert.equal(n.buffer, "abZcd");
  assert.equal(n.caret, 3);
});

test("delete-forward, end, and paste splice at the caret (CLI-065)", () => {
  let m = ask("abc", 0); // caret at start
  m = applyModalKey(m, key("delete"));
  assert.equal(m.buffer, "bc"); // deleted 'a' at caret
  m = applyModalKey(m, key("end"));
  assert.equal(m.caret, 2);
  m = applyModalKey(m, key("paste", "X\nY")); // newlines flattened to spaces
  assert.equal(m.buffer, "bcX Y");
});

test("ASCII editing matches simple splice; caret clamps in range (CLI-065)", () => {
  let m = ask("hi", 2);
  m = applyModalKey(m, key("right")); // already at end → clamps
  assert.equal(m.caret, 2);
  m = applyModalKey(m, key("backspace"));
  m = applyModalKey(m, key("backspace"));
  m = applyModalKey(m, key("backspace")); // empty → no-op
  assert.equal(m.buffer, "");
  assert.equal(m.caret, 0);
});

test("modalCursorCol: confirm parks after [y/N]; ask tracks the caret in columns (CLI-065)", () => {
  assert.equal(
    modalCursorCol({ kind: "confirm", prompt: "ok?", buffer: "", caret: 0 }),
    stringWidth("? ok? [y/N]"),
  );
  assert.equal(modalCursorCol(ask("hello", 3)), stringWidth("› value: hel"));
});

test("renderModal: a hint row renders dim below the prompt, clamped (CLI-066)", () => {
  const m: ModalView = {
    kind: "ask",
    prompt: "folder:",
    buffer: "~/AL",
    caret: 4,
    hint: "ALPHA/  AL2/  … +3",
  };
  const lines = renderModal(m, 80, "none").map(strip);
  assert.equal(lines.length, 2); // prompt + hint
  assert.match(lines[0] ?? "", /^› folder: ~\/AL$/);
  assert.match(lines[1] ?? "", /ALPHA\/.*AL2\/.*\+3/);
  // no hint → single line (unchanged).
  assert.equal(renderModal({ ...m, hint: undefined }, 80, "none").length, 1);
});

test("the TUI restores the saved authorisation level instead of overwriting it with the default", async () => {
  /**
   * `/authorisation N` says "saved as default", and it truthfully wrote the file — to the
   * os.homedir()-rooted config tree that every writer uses. The TUI's startup READ used the
   * `~/.prometheus` state tree instead, a directory nothing ever creates, so it always missed.
   * The level then fell back to the sudo-derived default and `setAuthLevel` persisted THAT over
   * the user's real choice: the posture silently reset to 1 on every launch, and the readline
   * host was dragged down with it because the two share one file.
   *
   * The reader and the writer are pinned to one root here, so they cannot drift apart again.
   */
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { cliProfiles } = await import("@prometheus/core");

  const configHome = mkdtempSync(join(tmpdir(), "prom-authcfg-"));
  const dir = cliProfiles.configDir(configHome);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "authorisation.json");
  writeFileSync(file, JSON.stringify({ level: 6 }));

  const { readSavedAuthLevel } = await import("../session/authorisation-store.js");
  assert.equal(readSavedAuthLevel(configHome), 6, "precondition: the store holds the saved level");

  // the STATE tree is a different directory and holds nothing — reading there is the bug
  const stateHome = mkdtempSync(join(tmpdir(), "prom-authstate-"));
  assert.equal(
    readSavedAuthLevel(stateHome),
    null,
    "precondition: the state tree has no authorisation store, so reading it always misses",
  );

  // the level the TUI actually starts at
  assert.equal(
    resolveStartAuthLevel(configHome, "default"),
    6,
    "the saved posture must survive a restart",
  );
  // handed the STATE tree — the old argument — the same call silently returns the default
  assert.equal(
    resolveStartAuthLevel(stateHome, "default"),
    agent.modeToAuthLevel("default"),
    "reading the state tree cannot see the saved level; that is what silently downgraded it",
  );
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).level,
    6,
    "and the saved file must not be rewritten with a default the user never chose",
  );
});

test("CLOCK DRIFT GUARD: the turn clock is painted by elapsed time, never as `muted` grey", async () => {
  // A source-level guard, because the defect this replaces was NOT in a pure unit: `paintDuration`
  // can be perfect and the TUI still print a grey clock if app.ts reverts to `paint(…, "muted")`.
  // The raw-TTY turn loop cannot be driven from node:test, so the wiring itself is what's asserted.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");
  const clock = src.split("\n").filter((l) => l.includes("⏱"));
  assert.equal(clock.length, 1, "expected exactly one ⏱ clock line in app.ts");
  const line = clock[0] as string;
  assert.match(line, /paintDuration\(/, "the clock stopped using the elapsed-time painter");
  assert.doesNotMatch(line, /"muted"/, "the clock went back to the near-invisible grey");
  assert.match(line, /elapsedMs/, "the clock is not passing the elapsed span to the painter");
});
