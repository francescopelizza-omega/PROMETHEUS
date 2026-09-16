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

/**
 * The TUI's startup write, driven through the REAL `launchTui`.
 *
 * The previous guard in this file exercised `resolveStartAuthLevel` — a pure function — while
 * the defect lived in the call site next to it, so reverting app.ts to the exact bug its own
 * docblock describes left every test in this file green. This one opens the actual TUI over
 * injected streams, which is the only thing that can tell "the level is restored" from "the
 * level is restored and then written back over".
 */
async function driveTui(configHome: string, over: Record<string, unknown> = {}): Promise<number> {
  const { EventEmitter } = await import("node:events");
  class FakeIn extends EventEmitter {
    isTTY = true;
    setRawMode(): this {
      return this;
    }
    resume(): this {
      return this;
    }
    pause(): this {
      return this;
    }
    setEncoding(): this {
      return this;
    }
  }
  class FakeOut extends EventEmitter {
    columns = 100;
    rows = 30;
    isTTY = true;
    write(): boolean {
      return true;
    }
  }
  const stdin = new FakeIn();
  // Ctrl-D closes the session the way a real one does; `end` is the belt-and-braces backstop.
  setTimeout(() => stdin.emit("data", Buffer.from("\x04")), 400);
  setTimeout(() => stdin.emit("end"), 2_000);
  const { launchTui } = await import("./app.js");
  return launchTui(
    {
      command: [],
      positionals: [],
      json: false,
      noColor: true,
      help: false,
      version: false,
      repl: true,
      dryRun: false,
      yes: false,
      strict: false,
      force: false,
      noGate: false,
      verbose: false,
      quiet: false,
      flags: {},
      cwd: configHome,
      ...over,
    } as never,
    {
      stdin: stdin as never,
      stdout: new FakeOut() as never,
      isTty: true,
      configHome,
      home: configHome,
      backends: {
        liveRunners: [],
        paidClis: [],
        startedRunners: new Set<string>(),
        unavailableRunners: [],
      },
    },
  );
}

test("opening the TUI neither creates the authorisation store nor rewrites a saved level", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const authFile = (h: string): string => join(h, ".prometheus", "config", "authorisation.json");

  // (a) a machine that has never set a level: opening a session must write NOTHING. The startup
  // call used to persist unconditionally, so a first launch stamped the default onto disk —
  // and every later read miss or safety clamp became permanent the same way.
  const fresh = mkdtempSync(join(tmpdir(), "prom-tui-fresh-"));
  await driveTui(fresh);
  assert.equal(existsSync(authFile(fresh)), false, "a launch must not create the store");

  // (b) a saved level survives a launch untouched — same bytes, not merely the same number.
  const seeded = mkdtempSync(join(tmpdir(), "prom-tui-seeded-"));
  mkdirSync(join(seeded, ".prometheus", "config"), { recursive: true });
  writeFileSync(authFile(seeded), '{"level":7}');
  await driveTui(seeded);
  assert.equal(readFileSync(authFile(seeded), "utf8"), '{"level":7}', "the launch rewrote it");
});

test("logCrash persists the ACTUAL error to <home>/logs/crashes (crash-log regression)", async () => {
  /**
   * `onCrash` used to be declared with ZERO parameters, yet was registered directly as the
   * process's `uncaughtException`/`unhandledRejection` listener. Node hands that listener the
   * actual error — dropped on the floor by the missing parameter. The terminal was restored and
   * the process exited clean, but there was no log file, no stderr line, no trace anywhere of
   * what threw. A session that died this way was undiagnosable after the fact.
   *
   * This drives `logCrash` directly rather than emitting a real `uncaughtException` on
   * `process`: that event is global, and node:test's own runner listens for it too, so a
   * synthetic emit gets treated as a real test-process crash by the harness itself.
   */
  const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { logCrash } = await import("./app.js");

  const home = mkdtempSync(join(tmpdir(), "prom-crash-log-"));
  const logPath = logCrash(home, new Error("boom from a test"));

  assert.ok(logPath, "logCrash must return the path it wrote");
  const files = readdirSync(join(home, "logs", "crashes"));
  assert.equal(files.length, 1, "expected exactly one crash log written");
  assert.match(
    readFileSync(logPath, "utf8"),
    /boom from a test/,
    "the crash log must contain the real error, not drop it",
  );

  // a non-Error rejection reason (a thrown string/object) must still be captured, not `String`-ed
  // into "[object Object]" or dropped for lacking a `.stack`.
  const logPath2 = logCrash(home, "a raw rejection reason, not an Error");
  assert.match(
    readFileSync(logPath2, "utf8"),
    /a raw rejection reason, not an Error/,
    "a non-Error crash reason must be captured too",
  );
});

test("SOURCE GUARD: onCrash takes the error Node hands it and threads it through logCrash", async () => {
  // The defect was structural — a zero-arg `onCrash` registered as the crash listener — so this
  // guards the wiring itself, the same way CLOCK DRIFT GUARD above guards app.ts's call site
  // rather than only the pure helper.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL("./app.ts", import.meta.url)), "utf8");
  assert.match(
    src,
    /function onCrash\(err: unknown\)/,
    "onCrash must take the error as a parameter, not silently drop it",
  );
  assert.match(src, /logCrash\(home, err\)/, "onCrash must persist the real error via logCrash");
});
