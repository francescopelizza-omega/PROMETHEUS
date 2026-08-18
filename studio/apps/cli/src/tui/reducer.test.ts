/**
 * reducer.test.ts — the composer state machine: editing, dropdown nav, history,
 * mode cycle, Ctrl-C dance, paste sanitize.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CompleterFs } from "../session/path-completer.js";
import type { AcItem } from "./autocomplete.js";
import { type KeyEvent, type KeyName, resolveKeymap } from "./keys.js";
import {
  type ReduceCtx,
  type TuiState,
  countPasteLines,
  cycleActivePane,
  expandPastes,
  initialTuiState,
  moveCaretTo,
  pastePlaceholder,
  reduce,
  sanitizePaste,
  setMode,
  shouldCollapsePaste,
} from "./reducer.js";

const ITEMS: AcItem[] = [
  { name: "scan", summary: "scan" },
  { name: "status", summary: "status" },
  { name: "install", summary: "install", args: "<id>" },
  // an OPTIONAL arg (must still run on the first Enter) and an ALIASED command (the typed
  // alias must survive submit) — neither matches "s"/"sc", so the ranking tests are unchanged.
  { name: "vault", summary: "vault", args: "[action]" },
  { name: "think", summary: "think", aliases: ["effort"] },
];
const CTX: ReduceCtx = { items: ITEMS, running: false };

/** A fake fs: a map of dir → entries, and a set of dirs (everything else is a file). */
function fakeFs(tree: Record<string, string[]>, dirs: string[]): CompleterFs {
  const dirSet = new Set(dirs);
  return {
    readdirSync: (p) => {
      const key = p.replace(/\/$/, "") || "/";
      const v = tree[key] ?? tree[p];
      if (!v) throw new Error("ENOENT");
      return v;
    },
    isDir: (p) => dirSet.has(p),
  };
}

/** A ReduceCtx with "@"-path completion wired up (reducer.test.ts's other CTX fixtures
 *  never set `pathCompletion`, so `state.pathAc` stays permanently empty for them — this
 *  fixture is what actually exercises the new "@"-path dropdown keymap block). */
const PATH_FS = fakeFs(
  { "/proj": ["src", "README.md"], "/proj/src": ["reducer.ts", "autocomplete.ts"] },
  ["/proj", "/proj/src"],
);
const CTX_PATH: ReduceCtx = {
  items: ITEMS,
  running: false,
  pathCompletion: { baseDir: "/proj", fs: PATH_FS },
};

const k = (name: KeyName, ch?: string): KeyEvent => (ch === undefined ? { name } : { name, ch });

/** Feed a sequence of keys, return the final state + collected effects. */
function run(
  start: TuiState,
  keys: KeyEvent[],
  ctx: ReduceCtx = CTX,
): { state: TuiState; effects: ReturnType<typeof reduce>["effects"] } {
  let state = start;
  const effects: ReturnType<typeof reduce>["effects"] = [];
  for (const key of keys) {
    const r = reduce(state, key, ctx);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const typed = (s: string): KeyEvent[] => [...s].map((ch) => k("char", ch));

test("typing inserts at the caret + advances it", () => {
  const { state } = run(initialTuiState(), typed("hello"));
  assert.equal(state.input, "hello");
  assert.equal(state.cursor, 5);
});

test("backspace + left/right motion", () => {
  const { state } = run(initialTuiState(), [...typed("abc"), k("left"), k("backspace")]);
  assert.equal(state.input, "ac"); // deleted 'b' (caret was between b and c)
  assert.equal(state.cursor, 1);
});

test("astral chars edit as one unit", () => {
  const { state } = run(initialTuiState(), [...typed("a"), k("char", "😀"), k("backspace")]);
  assert.equal(state.input, "a");
});

test("word-left / word-right jump by word", () => {
  const s0 = run(initialTuiState(), typed("foo bar baz")).state;
  const left = reduce(s0, k("word-left"), CTX).state;
  assert.equal(left.cursor, 8); // start of "baz"
  const home = reduce(left, k("ctrl-a"), CTX).state;
  assert.equal(home.cursor, 0);
});

test("Enter submits, clears, and records history (deduped)", () => {
  const { state, effects } = run(initialTuiState(), [...typed("scan now"), k("enter")]);
  assert.equal(state.input, "");
  assert.deepEqual(effects, [{ type: "submit", text: "scan now" }]);
  assert.deepEqual(state.history, ["scan now"]);
});

test("history recall with ↑/↓ on a single line", () => {
  let s = initialTuiState();
  s = run(s, [...typed("first"), k("enter")]).state;
  s = run(s, [...typed("second"), k("enter")]).state;
  // start typing a draft, then ↑ recalls
  s = run(s, typed("dra")).state;
  const up1 = reduce(s, k("up"), CTX).state;
  assert.equal(up1.input, "second");
  const up2 = reduce(up1, k("up"), CTX).state;
  assert.equal(up2.input, "first");
  // ↓ back down to the live draft
  const down1 = reduce(up2, k("down"), CTX).state;
  assert.equal(down1.input, "second");
  const down2 = reduce(down1, k("down"), CTX).state;
  assert.equal(down2.input, "dra"); // restored draft
});

test("Ctrl-J inserts a newline; ↑/↓ move within the buffer before history", () => {
  const s = run(initialTuiState(), [...typed("line1"), k("newline"), ...typed("line2")]).state;
  assert.equal(s.input, "line1\nline2");
  // caret on the 2nd line; ↑ moves to line1 (not history)
  const up = reduce(s, k("up"), CTX).state;
  assert.equal(up.input, "line1\nline2"); // unchanged buffer
  assert.ok(up.cursor < 6); // moved into line1
});

test("slash opens the dropdown; ↑/↓ navigate; Tab completes", () => {
  let s = run(initialTuiState(), typed("/s")).state;
  assert.equal(s.ac.items.length > 0, true);
  assert.equal(s.ac.items[0]?.name, "scan");
  s = reduce(s, k("down"), CTX).state; // → status
  assert.equal(s.ac.items[s.ac.index]?.name, "status");
  s = reduce(s, k("tab"), CTX).state; // complete
  assert.equal(s.input, "/status ");
  assert.equal(s.ac.items.length, 0); // closed (trailing space)
});

test("Enter on a no-arg command runs it; on a REQUIRED-arg command completes", () => {
  // no-arg → submit
  const noArg = run(initialTuiState(), typed("/scan"));
  const r1 = reduce(noArg.state, k("enter"), CTX);
  assert.deepEqual(r1.effects, [{ type: "submit", text: "/scan" }]);
  // required-arg command → complete + await args (no submit)
  const s = run(initialTuiState(), typed("/install")).state;
  const r2 = reduce(s, k("enter"), CTX);
  assert.equal(r2.state.input, "/install ");
  assert.equal(r2.effects.length, 0);
});

test("Enter SUBMITS a command whose arg is OPTIONAL — one press, not two", () => {
  // "[action]" is optional: holding it made ~40 commands need a second Enter, and the
  // next command typed after the first press got glued on as this one's argument.
  const s = run(initialTuiState(), typed("/vault")).state;
  const r = reduce(s, k("enter"), CTX);
  assert.deepEqual(r.effects, [{ type: "submit", text: "/vault" }]);
  assert.equal(r.state.input, "");
});

test("Enter on a required-arg command SUBMITS once the arg is typed", () => {
  // type the whole line, then walk the caret back INTO the command token so the dropdown
  // re-opens over "/install" — the arg is already there, so Enter must run it, not re-hold.
  const s = run(initialTuiState(), [
    ...typed("/install foo"),
    k("left"),
    k("left"),
    k("left"),
    k("left"),
  ]).state;
  assert.equal(s.ac.items[s.ac.index]?.name, "install"); // dropdown is open again
  const r = reduce(s, k("enter"), CTX);
  assert.deepEqual(r.effects, [{ type: "submit", text: "/install foo" }]);
});

test("Enter submits the TYPED alias, not the primary name", () => {
  // "/effort" is an alias of "think": submitting `/${sel.name}` silently ran a different
  // command than the one the user typed.
  const s = run(initialTuiState(), typed("/effort")).state;
  assert.equal(s.ac.items[s.ac.index]?.name, "think");
  const r = reduce(s, k("enter"), CTX);
  assert.deepEqual(r.effects, [{ type: "submit", text: "/effort" }]);
});

test("Enter on a PARTIAL completes to the highlighted command's primary name", () => {
  const s = run(initialTuiState(), typed("/sca")).state;
  assert.equal(s.ac.items[s.ac.index]?.name, "scan");
  const r = reduce(s, k("enter"), CTX);
  assert.deepEqual(r.effects, [{ type: "submit", text: "/scan" }]);
});

test("Tab on a closed slash buffer opens the menu FILTERED by the query (not all)", () => {
  // dropdown closed, buffer "/sc" → Tab must filter to scan, not list everything
  const s = initialTuiState({ input: "/sc", cursor: 3 });
  const r = reduce(s, k("tab"), CTX);
  assert.ok(r.state.ac.items.length >= 1);
  assert.equal(r.state.ac.items[0]?.name, "scan");
  assert.ok(!r.state.ac.items.some((i) => i.name === "install")); // 'install' doesn't match 'sc'
});

test("Esc closes the dropdown without exiting / clears a draft", () => {
  const open = run(initialTuiState(), typed("/sc")).state;
  const closed = reduce(open, k("esc"), CTX).state;
  assert.equal(closed.ac.items.length, 0);
  assert.equal(closed.input, "/sc"); // input kept, dropdown gone
  // esc again clears the draft
  const cleared = reduce(closed, k("esc"), CTX).state;
  assert.equal(cleared.input, "");
});

test("Shift-Tab cycles default → acceptEdits → plan → bypass → yolo → default (unlocked)", () => {
  let s = initialTuiState();
  s = reduce(s, k("backtab"), CTX).state;
  assert.equal(s.permMode, "acceptEdits");
  s = reduce(s, k("backtab"), CTX).state;
  assert.equal(s.permMode, "plan");
  s = reduce(s, k("backtab"), CTX).state;
  assert.equal(s.permMode, "bypassPermissions");
  s = reduce(s, k("backtab"), CTX).state;
  assert.equal(s.permMode, "yolo"); // dial all the way up to full autonomy
  const r = reduce(s, k("backtab"), CTX);
  assert.equal(r.state.permMode, "default");
  assert.equal(r.effects.at(-1)?.type, "mode-changed");
});

test("Shift-Tab skips bypass when it is locked (declined-sudo)", () => {
  let s = initialTuiState({ bypassLocked: true });
  s = reduce(s, k("backtab"), CTX).state; // acceptEdits
  s = reduce(s, k("backtab"), CTX).state; // plan
  s = reduce(s, k("backtab"), CTX).state; // back to default — bypass never reached
  assert.equal(s.permMode, "default");
});

test("setMode honors the bypass lock", () => {
  const locked = initialTuiState({ bypassLocked: true });
  const r = setMode(locked, "bypassPermissions");
  assert.equal(r.state.permMode, "default"); // unchanged
  assert.equal(r.effects[0]?.type, "notice");
  const ok = setMode(initialTuiState(), "bypassPermissions");
  assert.equal(ok.state.permMode, "bypassPermissions");
});

test("Ctrl-C: clears text, then arms, then exits on empty", () => {
  const withText = run(initialTuiState(), typed("abc")).state;
  const cleared = reduce(withText, k("ctrl-c"), CTX).state;
  assert.equal(cleared.input, ""); // first press clears
  const armed = reduce(cleared, k("ctrl-c"), CTX);
  assert.equal(armed.state.pendingExit, true);
  assert.equal(armed.effects[0]?.type, "notice");
  const exit = reduce(armed.state, k("ctrl-c"), CTX);
  assert.deepEqual(exit.effects, [{ type: "exit", code: 130 }]);
});

test("Ctrl-C during a running op interrupts (not exit)", () => {
  const r = reduce(initialTuiState(), k("ctrl-c"), { items: ITEMS, running: true });
  assert.deepEqual(r.effects, [{ type: "interrupt" }]);
});

test("Ctrl-D exits on an empty line only", () => {
  assert.deepEqual(reduce(initialTuiState(), k("ctrl-d"), CTX).effects, [
    { type: "exit", code: 0 },
  ]);
  const withText = run(initialTuiState(), typed("x")).state;
  assert.equal(reduce(withText, k("ctrl-d"), CTX).effects.length, 0);
});

test("sanitizePaste strips control bytes, keeps \\n/\\t, normalizes CRLF", () => {
  assert.equal(sanitizePaste("a\r\nb\tc\x1b[31m"), "a\nb\tc[31m");
  // a multi-line paste inserts literally and never submits
  const r = reduce(initialTuiState(), { name: "paste", ch: "one\r\ntwo" }, CTX);
  assert.equal(r.state.input, "one\ntwo");
  assert.equal(r.effects.length, 0);
});

test("Ctrl-T emits a tools-toggle effect (CLI-018)", () => {
  const { effects } = run(initialTuiState(), [k("ctrl-t")]);
  assert.deepEqual(effects, [{ type: "tools-toggle" }]);
});

/* ── CLI-019: Ctrl-R reverse-i-search ──────────────────────────────────────── */

const HIST = () =>
  initialTuiState({
    history: ["scan repo", "install foo", "scan deep"],
    input: "current",
    cursor: 7,
  });

test("Ctrl-R enters search; typing narrows to the newest match (CLI-019)", () => {
  const { state } = run(HIST(), [k("ctrl-r")]);
  assert.ok(state.search, "search active after Ctrl-R");
  assert.equal(state.search?.matchIndex, 2); // empty query recalls newest
  const narrowed = run(HIST(), [k("ctrl-r"), ...typed("install")]).state;
  assert.equal(narrowed.search?.query, "install");
  assert.equal(narrowed.search?.matchIndex, 1); // "install foo"
});

test("repeated Ctrl-R cycles strictly older, then fails without moving (CLI-019)", () => {
  const a = run(HIST(), [k("ctrl-r"), ...typed("scan")]).state;
  assert.equal(a.search?.matchIndex, 2); // "scan deep" (newest)
  const b = run(HIST(), [k("ctrl-r"), ...typed("scan"), k("ctrl-r")]).state;
  assert.equal(b.search?.matchIndex, 0); // "scan repo" (older)
  const c = run(HIST(), [k("ctrl-r"), ...typed("scan"), k("ctrl-r"), k("ctrl-r")]).state;
  assert.equal(c.search?.matchIndex, 0); // no older → unchanged
  assert.equal(c.search?.failing, true);
});

test("Enter accepts the match into the composer WITHOUT submitting (CLI-019)", () => {
  const { state, effects } = run(HIST(), [k("ctrl-r"), ...typed("install"), k("enter")]);
  assert.equal(state.input, "install foo");
  assert.equal(state.search, null);
  assert.ok(!effects.some((e) => e.type === "submit"), "accept must not submit");
});

test("Esc cancels: exact prior buffer + caret restored (CLI-019)", () => {
  const { state } = run(HIST(), [k("ctrl-r"), ...typed("scan"), k("esc")]);
  assert.equal(state.input, "current");
  assert.equal(state.cursor, 7);
  assert.equal(state.search, null);
});

test("mid-search a stray key is inert; empty history never crashes (CLI-019)", () => {
  const inert = run(HIST(), [k("ctrl-r"), ...typed("scan"), k("left")]).state;
  assert.ok(inert.search, "still searching after a left-arrow");
  assert.equal(inert.input, "current"); // nothing leaked into the buffer
  assert.equal(inert.search?.query, "scan");
  const empty = run(initialTuiState({ history: [], input: "x", cursor: 1 }), [k("ctrl-r")]).state;
  assert.equal(empty.search?.matchIndex, -1);
  assert.equal(empty.search?.failing, true);
});

// ── CLI-059: the /invoke overlay is modal in the reducer ─────────────────────────
test("/invoke overlay: keys route to the overlay while open; Enter→args→dispatch (CLI-059)", async () => {
  const { openInvokeOverlay } = await import("./invoke-overlay.js");
  const overlay = openInvokeOverlay([
    { name: "nemesis", summary: "scanner", presence: "present" },
    { name: "gatekeeper", summary: "gate tool", presence: "absent" },
  ]);
  const start = initialTuiState({ invokeOverlay: overlay, input: "" });

  // ↓ moves the overlay selection, NOT the composer (input stays empty).
  const moved = run(start, [k("down")]);
  assert.equal(moved.state.invokeOverlay?.index, 1);
  assert.equal(moved.state.input, ""); // composer untouched while modal

  // Enter → args stage, type args, Enter → an invoke-dispatch effect + overlay closes.
  const toArgs = run(moved.state, [k("enter")]);
  assert.equal(toArgs.state.invokeOverlay?.stage, "args");
  const dispatched = run(toArgs.state, [k("char", "-"), k("char", "y"), k("enter")]);
  assert.equal(dispatched.state.invokeOverlay, null); // closed
  // filtered is alphabetical ([gatekeeper, nemesis]); ↓ moved to index 1 = nemesis.
  assert.deepEqual(dispatched.effects.at(-1), {
    type: "invoke-dispatch",
    name: "nemesis",
    args: "-y",
  });
});

test("/invoke overlay: Esc closes it with no dispatch (CLI-059)", async () => {
  const { openInvokeOverlay } = await import("./invoke-overlay.js");
  const start = initialTuiState({
    invokeOverlay: openInvokeOverlay([{ name: "x", summary: "y", presence: "unknown" }]),
  });
  const { state, effects } = run(start, [k("esc")]);
  assert.equal(state.invokeOverlay, null);
  assert.deepEqual(effects, []);
});

// ── CLI-060: activePane groundwork (multi-pane cycle) ────────────────────────────
test("activePane defaults to the composer/transcript pane (CLI-060)", () => {
  assert.equal(initialTuiState().activePane, "transcript");
});

test("cycleActivePane advances through every PaneId and wraps, one effect each (CLI-060)", async () => {
  const { repl } = await import("@prometheus/core");
  const { cycleActivePane } = await import("./reducer.js");
  let state = initialTuiState();
  const seen: string[] = [state.activePane];
  // cycle PANE_CYCLE.length + 1 times → back to the start (wrap).
  for (let i = 0; i < repl.PANE_CYCLE.length + 1; i++) {
    const r = cycleActivePane(state);
    // exactly one pane-changed effect per cycle (not one-per-pane).
    assert.equal(r.effects.filter((e) => e.type === "pane-changed").length, 1);
    assert.deepEqual(r.effects[0], { type: "pane-changed", pane: r.state.activePane });
    state = r.state;
    seen.push(state.activePane);
  }
  // every pane in the cycle was visited.
  for (const pane of repl.PANE_CYCLE) assert.ok(seen.includes(pane), `visited ${pane}`);
  // wrapped: after length+1 cycles from transcript, we're back one past the start.
  assert.equal(seen.at(-1), repl.PANE_CYCLE[1]); // one full wrap + 1 more = second pane
});

test("cycleActivePane leaves the input buffer untouched (CLI-060)", () => {
  const start = { ...initialTuiState(), input: "hello", cursor: 5 };
  const { state } = cycleActivePane(start);
  assert.equal(state.input, "hello");
  assert.equal(state.cursor, 5);
});

// ── CLI-062: seeded (persisted) history recalls newest-first ─────────────────────
test("seeded input history recalls newest-first via ↑ (CLI-062)", () => {
  // simulate a restart: initial state seeded from the on-disk history (oldest→newest).
  const s0 = initialTuiState({ history: ["first", "second", "third"] });
  const up1 = reduce(s0, k("up"), CTX).state;
  assert.equal(up1.input, "third"); // newest first
  const up2 = reduce(up1, k("up"), CTX).state;
  assert.equal(up2.input, "second");
  const up3 = reduce(up2, k("up"), CTX).state;
  assert.equal(up3.input, "first");
});

// ── CLI-063: large-paste placeholders ────────────────────────────────────────────
const bigPaste = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n");

test("a 200-line paste collapses to exactly one placeholder line (CLI-063)", () => {
  const text = bigPaste(200);
  const { state } = run(initialTuiState(), [k("paste", text)]);
  assert.equal(state.input, "[Pasted text #1, 200 lines]");
  assert.equal(state.input.split("\n").length, 1); // ONE line in the composer
  assert.equal(state.pastes.length, 1);
  assert.equal(state.pastes[0]?.text, text);
});

test("submitting expands the placeholder to the full original text (CLI-063)", () => {
  const text = bigPaste(200);
  const s = run(initialTuiState(), [k("paste", text)]).state;
  const r = reduce(s, k("enter"), CTX);
  assert.deepEqual(r.effects, [{ type: "submit", text }]); // byte-identical original
  assert.equal(r.state.pastes.length, 0); // stash reset per turn
  assert.equal(r.state.pasteSeq, 0);
  assert.deepEqual(r.state.history, ["[Pasted text #1, 200 lines]"]); // history keeps the chip
});

test("two pastes get #1 and #2, each expands to its own content (CLI-063)", () => {
  const a = bigPaste(10);
  const b = bigPaste(20);
  let s = run(initialTuiState(), [k("paste", a)]).state;
  s = run(s, [k("char", " ")]).state; // edit between them
  s = run(s, [k("paste", b)]).state;
  assert.match(s.input, /#1, 10 lines.* .*#2, 20 lines/);
  const r = reduce(s, k("enter"), CTX);
  const emitted = (r.effects[0] as { text: string }).text;
  assert.match(emitted, /line 0[\s\S]*line 9/); // #1 content
  assert.match(emitted, /line 0[\s\S]*line 19/); // #2 content
});

test("one backspace deletes an entire placeholder + drops its stash entry (CLI-063)", () => {
  const s = run(initialTuiState(), [k("paste", bigPaste(50))]).state;
  assert.equal(s.input, "[Pasted text #1, 50 lines]");
  const del = reduce(s, k("backspace"), CTX).state; // caret at end, just after `]`
  assert.equal(del.input, ""); // whole chip removed atomically
  assert.equal(del.pastes.length, 0); // stash entry dropped
});

test("a hand-TYPED placeholder lookalike is NOT expanded (forgery guard) (CLI-063)", () => {
  // no stash id → passes through untouched.
  assert.equal(
    expandPastes("see [Pasted text #1, 5 lines] here", []),
    "see [Pasted text #1, 5 lines] here",
  );
  // typed by hand in the composer, then submitted → emitted verbatim.
  const s = run(initialTuiState(), typed("[Pasted text #1, 5 lines]")).state;
  const r = reduce(s, k("enter"), CTX);
  assert.equal((r.effects[0] as { text: string }).text, "[Pasted text #1, 5 lines]");
});

test("deleting #1 then submitting emits only #2; #1 stash entry is dropped (CLI-063)", () => {
  let s = run(initialTuiState(), [k("paste", bigPaste(10))]).state; // #1 at buffer end
  s = reduce(s, k("backspace"), CTX).state; // delete #1 whole
  assert.equal(s.pastes.length, 0);
  s = run(s, [k("paste", bigPaste(20))]).state; // #2
  const emitted = (reduce(s, k("enter"), CTX).effects[0] as { text: string }).text;
  assert.match(emitted, /line 19/); // #2 content present
  assert.ok(!emitted.includes("#1"), "no dangling #1 placeholder");
});

test("paste helpers: countPasteLines / shouldCollapsePaste / pastePlaceholder (CLI-063)", () => {
  assert.equal(countPasteLines("a\nb\nc"), 3);
  assert.equal(countPasteLines("a\nb\nc\n"), 3); // trailing newline doesn't inflate
  assert.equal(countPasteLines(""), 0);
  assert.equal(shouldCollapsePaste("a\nb"), false); // 2 lines, short → verbatim
  assert.equal(shouldCollapsePaste("a\nb\nc\nd"), true); // >3 lines
  assert.equal(shouldCollapsePaste("x".repeat(201)), true); // >200 chars
  assert.equal(pastePlaceholder(3, 1), "[Pasted text #3, 1 line]");
});

test("a small paste inserts verbatim (no collapse) (CLI-063)", () => {
  const { state } = run(initialTuiState(), [k("paste", "just one short line")]);
  assert.equal(state.input, "just one short line");
  assert.equal(state.pastes.length, 0);
});

test("Ctrl-C / Esc clear also resets the paste stash (CLI-063)", () => {
  const s = run(initialTuiState(), [k("paste", bigPaste(50))]).state;
  assert.equal(s.pastes.length, 1);
  const cleared = reduce(s, k("ctrl-c"), CTX).state;
  assert.equal(cleared.input, "");
  assert.equal(cleared.pastes.length, 0);
  assert.equal(cleared.pasteSeq, 0);
});

// ── CLI-067: Ctrl+G pane cycle + Ctrl+S save ─────────────────────────────────────
test("Ctrl+G cycles the pane (emits pane-changed), buffer untouched (CLI-067)", () => {
  const s = { ...initialTuiState(), input: "draft here", cursor: 5 };
  const r = reduce(s, k("ctrl-g"), CTX);
  assert.equal(r.state.activePane, "catalog"); // transcript → catalog (PANE_CYCLE)
  assert.deepEqual(r.effects, [{ type: "pane-changed", pane: "catalog" }]);
  assert.equal(r.state.input, "draft here"); // buffer byte-identical
  assert.equal(r.state.cursor, 5);
});

test("Ctrl+S emits save-transcript, buffer untouched (CLI-067)", () => {
  const s = { ...initialTuiState(), input: "keep me", cursor: 3 };
  const r = reduce(s, k("ctrl-s"), CTX);
  assert.deepEqual(r.effects, [{ type: "save-transcript" }]);
  assert.equal(r.state.input, "keep me");
  assert.equal(r.state.cursor, 3);
});

test("Ctrl+G is ignored while the /invoke modal owns keys (CLI-067)", () => {
  // a modal-owning state (invokeOverlay set) routes Ctrl+G to the overlay, not the pane cycle.
  const withOverlay = {
    ...initialTuiState(),
    invokeOverlay: {
      all: [],
      filtered: [],
      index: 0,
      query: "",
      stage: "list" as const,
      argInput: "",
    },
  };
  const r = reduce(withOverlay, k("ctrl-g"), CTX);
  assert.equal(r.state.activePane, "transcript"); // NOT cycled — overlay swallowed it
  assert.ok(!r.effects.some((e) => e.type === "pane-changed"));
});

test("Ctrl+Y emits copy-reply, buffer untouched (CLI-068)", () => {
  const s = { ...initialTuiState(), input: "draft", cursor: 2 };
  const r = reduce(s, k("ctrl-y"), CTX);
  assert.deepEqual(r.effects, [{ type: "copy-reply" }]);
  assert.equal(r.state.input, "draft");
});

test("mouse wheel over an OPEN dropdown moves the highlight; closed → no-op (CLI-069)", () => {
  const open = run(initialTuiState(), typed("/s")).state; // dropdown open (scan, status)
  const i0 = open.ac.index;
  const down = reduce(
    open,
    { name: "mouse", mouse: { button: 0, x: 1, y: 1, pressed: true, wheel: "down" } },
    CTX,
  ).state;
  assert.equal(down.ac.index, (i0 + 1) % open.ac.items.length);
  const up = reduce(
    down,
    { name: "mouse", mouse: { button: 0, x: 1, y: 1, pressed: true, wheel: "up" } },
    CTX,
  ).state;
  assert.equal(up.ac.index, i0);
  // dropdown closed → wheel is a no-op (not intercepted).
  const closed = reduce(
    initialTuiState(),
    { name: "mouse", mouse: { button: 0, x: 1, y: 1, pressed: true, wheel: "down" } },
    CTX,
  );
  assert.equal(closed.state.input, "");
  assert.deepEqual(closed.effects, []);
});

test("moveCaretTo clamps + repositions the caret (CLI-069)", () => {
  const s = { ...initialTuiState(), input: "hello", cursor: 5 };
  assert.equal(moveCaretTo(s, 2, CTX).state.cursor, 2);
  assert.equal(moveCaretTo(s, 99, CTX).state.cursor, 5); // clamps to len
  assert.equal(moveCaretTo(s, -3, CTX).state.cursor, 0);
});

// ── CLI-070: grapheme-cluster-aware backspace/left/right in the MAIN composer ─────
test("backspace deletes a full grapheme cluster in one press (CLI-070)", () => {
  const cases: [string, string][] = [
    ["👨‍👩‍👧‍👦", ""], // ZWJ family (7 code points) → gone in ONE backspace
    ["🇯🇵", ""], // flag (2 regional indicators) → one unit
    ["👍🏽", ""], // skin-tone modifier (base + modifier) → one unit
    ["é", ""], // e + combining acute → one unit
  ];
  for (const [glyph, after] of cases) {
    const s = run(initialTuiState(), [k("paste", glyph)]).state;
    const del = reduce(s, k("backspace"), CTX).state;
    assert.equal(del.input, after, `"${glyph}" should delete in one backspace`);
  }
});

test("Left/Right step by grapheme cluster, matching backspace (CLI-070)", () => {
  const family = "👨‍👩‍👧‍👦";
  const s = run(initialTuiState(), [k("char", "a"), k("paste", family), k("char", "b")]).state;
  assert.equal(s.input, `a${family}b`);
  assert.equal(s.cursor, [...`a${family}b`].length); // caret at end (code-point index)
  // Left once → before 'b'; Left again → before the whole family (one step over the cluster).
  const l1 = reduce(s, k("left"), CTX).state;
  const l2 = reduce(l1, k("left"), CTX).state;
  assert.equal(l2.cursor, 1); // just after 'a', before the family (skipped all 7 code points)
  // Right once → back over the whole family in one step.
  const r1 = reduce(l2, k("right"), CTX).state;
  assert.equal(r1.cursor, 1 + [...family].length);
});

test("two flags = 2 clusters; each backspaces separately (CLI-070)", () => {
  const s = run(initialTuiState(), [k("paste", "🇯🇵🇺🇸")]).state; // JP + US = 4 code points, 2 clusters
  const d1 = reduce(s, k("backspace"), CTX).state;
  assert.equal(d1.input, "🇯🇵"); // one flag removed
  const d2 = reduce(d1, k("backspace"), CTX).state;
  assert.equal(d2.input, ""); // the other flag removed
});

test("delete-forward removes a whole cluster; ASCII editing unchanged (CLI-070)", () => {
  const family = "👨‍👩‍👧‍👦";
  const s = { ...run(initialTuiState(), [k("paste", family), k("char", "x")]).state };
  const atStart = { ...s, cursor: 0 };
  assert.equal(reduce(atStart, k("delete"), CTX).state.input, "x"); // forward-delete the cluster
  // ASCII regression: single-char backspace/left still step by one.
  const ascii = run(initialTuiState(), [k("char", "a"), k("char", "b"), k("char", "c")]).state;
  assert.equal(reduce(ascii, k("backspace"), CTX).state.input, "ab");
  assert.equal(reduce(ascii, k("left"), CTX).state.cursor, 2);
});

/* ── CLI-096: keymap rebinding honored in the reducer (both dispatch contexts) ─────── */

test("CLI-096: a rebound key triggers its action in BOTH the composer and the dropdown contexts", () => {
  const km = resolveKeymap({ "history-prev": "pageup" }); // pageup → up → history-prev
  const ctxKm: ReduceCtx = { items: ITEMS, running: false, keymap: km };

  // baseline: without a keymap, pageup has no reducer case → no effect.
  const hist = initialTuiState({ history: ["scan now"] });
  assert.equal(reduce(hist, k("pageup"), CTX).state.input, "");

  // composer context: the rebound pageup recalls history (what "up" used to do on empty input).
  assert.equal(reduce(hist, k("pageup"), ctxKm).state.input, "scan now");

  // dropdown-open context: the SAME rebound pageup moves the highlight (up), not history.
  const opened = run(initialTuiState(), typed("/s"), ctxKm).state; // scan + status
  assert.ok(opened.ac.items.length > 1, "the command menu opened");
  const moved = reduce({ ...opened, ac: { ...opened.ac, index: 1 } }, k("pageup"), ctxKm).state;
  assert.equal(moved.ac.index, 0, "rebound key navigates the dropdown too");
});

/* ── bug-fix regressions (whole-CLI review) ──────────────────────────────────────── */

test("sanitizePaste: a bare CR (and CRLF) normalizes to \\n — no \\r survives (spoof/line-count fix)", () => {
  assert.equal(sanitizePaste("a\rb\rc"), "a\nb\nc");
  assert.equal(sanitizePaste("a\r\nb"), "a\nb");
  assert.ok(!sanitizePaste("x\ry").includes("\r"));
});

test("history recall does NOT splice a fresh paste into a recalled placeholder (paste-stash isolation)", () => {
  // turn 1: a paste, submit → history holds the placeholder; pastes reset.
  let s = initialTuiState();
  s = run(s, [...typed("cmd1 "), k("paste", "AAAA\nBBBB\nCCCC\nDDDD\nEEEE")], CTX).state;
  const ph1 = s.input; // "cmd1 [Pasted text #1, 5 lines]"
  s = run(s, [k("enter")], CTX).state;
  assert.deepEqual(s.pastes, []);
  // turn 2: a DIFFERENT paste #1 is live in the stash.
  s = run(s, [k("paste", "zzz\nzzz\nzzz\nzzz")], CTX).state;
  assert.equal(s.pastes.length, 1);
  // recall turn 1 (Up): its placeholder text returns but the live stash must be parked → not spliced.
  const up = reduce(s, k("up"), CTX).state;
  assert.equal(up.input, ph1);
  assert.deepEqual(up.pastes, []); // recalled line's placeholders are inert
  // submit the recalled line: expandPastes finds no live #1 → the fresh paste is NOT emitted.
  const sub = reduce(up, k("enter"), CTX);
  const emitted = sub.effects.find((e) => e.type === "submit");
  assert.ok(
    emitted && !emitted.text.includes("zzz"),
    "must not splice turn-2 paste into turn-1 recall",
  );
  // Down back to the draft restores the parked stash.
  const up2 = reduce(s, k("up"), CTX).state;
  const down = reduce(up2, k("down"), CTX).state;
  assert.equal(down.pastes.length, 1); // draft paste restored
});

test("⌘←/→ (line-home/line-end) jump to the start/end of the CURRENT line in a multi-line draft", () => {
  // build a two-line draft: "foo\nbarbaz", caret parked mid-second-line.
  const base = run(initialTuiState(), [...typed("foo"), k("newline"), ...typed("barbaz")]).state;
  assert.equal(base.input, "foo\nbarbaz");
  const home = run(base, [k("line-home")]).state;
  assert.equal(home.cursor, 4); // start of "barbaz" (after the \n at index 3)
  const end = run(home, [k("line-end")]).state;
  assert.equal(end.cursor, base.input.length); // end of the second line
});

test("⌘↑/⌘↓ (history-entry-prev/next) jump whole prompts regardless of the cursor line", () => {
  const ctx: ReduceCtx = { items: ITEMS, running: false };
  const withHist: TuiState = { ...initialTuiState(), history: ["first prompt", "second prompt"] };
  // start a NEW multi-line draft, caret NOT on the first line
  const draft = run(withHist, [...typed("draft"), k("newline"), ...typed("line2")], ctx).state;
  // ⌘↑ recalls the newest history entry directly (does NOT line-move up through "line2")
  const up1 = run(draft, [k("history-entry-prev")], ctx).state;
  assert.equal(up1.input, "second prompt");
  const up2 = run(up1, [k("history-entry-prev")], ctx).state;
  assert.equal(up2.input, "first prompt");
  // ⌘↓ walks back toward newer, then restores the stashed live draft (empty-draft recovery)
  const down1 = run(up2, [k("history-entry-next")], ctx).state;
  assert.equal(down1.input, "second prompt");
  const down2 = run(down1, [k("history-entry-next")], ctx).state;
  assert.equal(down2.input, "draft\nline2"); // back to the parked draft
});

/* ── "@"-path completion dropdown (see tui/path-mentions.ts + tui/frame.ts) ──────────
 * Every ctx above omits `pathCompletion`, so `state.pathAc` stays permanently empty for
 * them — these tests are the only reducer-level coverage of the new keymap block and
 * the ac/pathAc precedence gate in commit(). */

test("typing @ opens the path dropdown, listing baseDir's entries", () => {
  const { state } = run(initialTuiState(), typed("@"), CTX_PATH);
  assert.ok(state.pathAc.items.length > 0, "the @ dropdown should be open");
  assert.ok(state.pathAc.items.some((i) => i.name === "src/"));
});

test("without pathCompletion wired, @ never opens the path dropdown", () => {
  const { state } = run(initialTuiState(), typed("@"), CTX);
  assert.deepEqual(state.pathAc.items, []);
});

test("up/down moves the path dropdown's highlight and wraps", () => {
  const open = run(initialTuiState(), typed("@"), CTX_PATH).state;
  const n = open.pathAc.items.length;
  const i0 = open.pathAc.index;
  const down = reduce(open, k("down"), CTX_PATH).state;
  assert.equal(down.pathAc.index, (i0 + 1) % n);
  const up = reduce(down, k("up"), CTX_PATH).state;
  assert.equal(up.pathAc.index, i0);
});

test("Tab on a highlighted DIRECTORY completes it, keeps the mention open one level deeper, and does NOT submit", () => {
  const open = run(initialTuiState(), typed("@s"), CTX_PATH).state; // "src" is the only match
  assert.ok(open.pathAc.items.some((i) => i.name === "src/"));
  const idx = open.pathAc.items.findIndex((i) => i.name === "src/");
  const withSrcHighlighted = { ...open, pathAc: { ...open.pathAc, index: idx } };
  const { state, effects } = run(withSrcHighlighted, [k("tab")], CTX_PATH);
  assert.equal(state.input, "@src/");
  assert.deepEqual(effects, [], "a directory step must not submit or record a frecency hit");
  assert.ok(
    state.pathAc.items.length > 0,
    "drilling deeper should re-open listing src/'s contents",
  );
});

test("Tab on a highlighted FILE completes it, closes the dropdown, and emits path-completed (not submit)", () => {
  const open = run(initialTuiState(), typed("@src/red"), CTX_PATH).state;
  assert.ok(open.pathAc.items.some((i) => i.name === "reducer.ts"));
  const idx = open.pathAc.items.findIndex((i) => i.name === "reducer.ts");
  const withFileHighlighted = { ...open, pathAc: { ...open.pathAc, index: idx } };
  const { state, effects } = run(withFileHighlighted, [k("tab")], CTX_PATH);
  assert.equal(state.input, "@src/reducer.ts ");
  assert.deepEqual(state.pathAc.items, [], "the dropdown must close on a file accept");
  assert.deepEqual(effects, [{ type: "path-completed", path: "/proj/src/reducer.ts" }]);
});

test("Enter behaves exactly like Tab on the path dropdown — it never submits the turn", () => {
  const open = run(initialTuiState(), typed("@src/red"), CTX_PATH).state;
  const idx = open.pathAc.items.findIndex((i) => i.name === "reducer.ts");
  const withFileHighlighted = { ...open, pathAc: { ...open.pathAc, index: idx } };
  const { effects } = run(withFileHighlighted, [k("enter")], CTX_PATH);
  assert.ok(
    !effects.some((e) => e.type === "submit"),
    "unlike the slash dropdown, Enter on a path mention must not submit — it's usually mid-sentence",
  );
});

test("Esc closes the path dropdown without touching the buffer", () => {
  const open = run(initialTuiState(), typed("@src"), CTX_PATH).state;
  assert.ok(open.pathAc.items.length > 0);
  const closed = reduce(open, k("esc"), CTX_PATH).state;
  assert.deepEqual(closed.pathAc.items, []);
  assert.equal(closed.input, "@src", "Esc on the path dropdown must not clear the composer");
});

test("Ctrl-C closes the path dropdown without arming the exit prompt", () => {
  const open = run(initialTuiState(), typed("@src"), CTX_PATH).state;
  const { state, effects } = run(open, [k("ctrl-c")], CTX_PATH);
  assert.deepEqual(state.pathAc.items, []);
  assert.equal(state.pendingExit, false);
  assert.deepEqual(effects, []);
});

test("backspace/left/right pass through normally while the path dropdown is open", () => {
  const open = run(initialTuiState(), typed("@src"), CTX_PATH).state;
  const backed = reduce(open, k("backspace"), CTX_PATH).state;
  assert.equal(backed.input, "@sr");
  const left = reduce(open, k("left"), CTX_PATH).state;
  assert.equal(left.cursor, open.cursor - 1);
});

test("after accepting a file completion, the dropdown stays closed and a later Enter submits normally", () => {
  // Enter/Tab ACCEPT while the path dropdown is open (see above) — it only submits once
  // the mention is resolved and the caret has moved past it (a trailing space, here).
  const withMention = run(initialTuiState(), typed("hi @src/red"), CTX_PATH).state;
  const idx = withMention.pathAc.items.findIndex((i) => i.name === "reducer.ts");
  const highlighted = { ...withMention, pathAc: { ...withMention.pathAc, index: idx } };
  const accepted = reduce(highlighted, k("tab"), CTX_PATH).state;
  assert.deepEqual(accepted.pathAc.items, [], "the dropdown closes once the file is accepted");
  const { state, effects } = run(accepted, [k("enter")], CTX_PATH);
  assert.ok(
    effects.some((e) => e.type === "submit"),
    "Enter now submits normally — the mention is resolved and no longer active",
  );
  assert.equal(state.input, "");
  assert.deepEqual(state.pathAc.items, []);
});

test("precedence: the slash and @-path dropdowns are never open at the same time, even for '/@'", () => {
  const state = run(initialTuiState(), typed("/@"), CTX_PATH).state;
  // rankSlash scores every real command -1 for a query containing "@" (no command name or
  // alias contains one), so `ac` never opens for this buffer and `pathAc` opens instead —
  // NOT the other way around (see the corrected comment in reducer.ts's commit()).
  assert.equal(state.ac.items.length, 0);
  assert.ok(state.pathAc.items.length > 0);
});

test("precedence: a real slash query keeps @-path closed even once an @ later appears (mid-arg)", () => {
  // "/scan @src" — cursor still inside the leading slash word only while there's no space
  // yet; once the space is typed, slashQuery closes ac and pathAc can open for "@src".
  const midCommand = run(initialTuiState(), typed("/sc"), CTX_PATH).state;
  assert.ok(midCommand.ac.items.length > 0);
  assert.deepEqual(midCommand.pathAc.items, []);
  const withMention = run(midCommand, typed("an @src"), CTX_PATH).state;
  assert.equal(withMention.ac.items.length, 0, "the slash dropdown closes once a space is typed");
  assert.ok(withMention.pathAc.items.length > 0, "and only THEN can the @ mention open");
});
