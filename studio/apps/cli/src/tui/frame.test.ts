/**
 * frame.test.ts — full-frame composition: box, dropdown placement, cursor offset,
 * bypass border, narrow-terminal collapse, width rule.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { syncAutocomplete } from "./autocomplete.js";
import type { AcItem } from "./autocomplete.js";
import { type FrameInput, renderFrame } from "./frame.js";
import { openInvokeOverlay } from "./invoke-overlay.js";
import { initialTuiState } from "./reducer.js";
import type { StatusModel } from "./status.js";

const STATUS: StatusModel = {
  permMode: "default",
  authLevel: 1,
  model: "qwen",
  modelSource: "local",
  tools: true,
  gate: "enforce",
  dryRun: false,
  profile: "default",
  cwd: "~/p",
};

const ITEMS: AcItem[] = [
  { name: "scan", summary: "scan" },
  { name: "status", summary: "status" },
];

const base = (over: Partial<FrameInput> = {}): FrameInput => ({
  state: initialTuiState(),
  status: STATUS,
  caps: "none",
  cols: 60,
  rows: 24,
  ...over,
});

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("default frame: box + status, caret inside the box", () => {
  const f = renderFrame(base({ state: initialTuiState({ input: "hi", cursor: 2 }) }));
  assert.ok(f.lines[0]?.includes("╭"));
  // a body row holds the prompt + text
  assert.ok(f.lines.some((l) => strip(l).includes("› hi")));
  // status bar present below the box
  assert.ok(f.lines.some((l) => strip(l).includes("[PROMETHEUS:DEFAULT]")));
  assert.equal(f.cursorRow, 1); // top border row 0, body row 1
  assert.equal(f.cursorCol, 4 + 2); // text col 4 + caret 2
});

test("every line stays within cols-1 (magic-margin guard)", () => {
  const f = renderFrame(base({ cols: 40, state: initialTuiState({ input: "x".repeat(100) }) }));
  for (const l of f.lines) assert.ok([...strip(l)].length <= 40 - 1, `line ≤ cols-1: ${strip(l)}`);
});

test("open dropdown renders ABOVE the box and pushes the caret down", () => {
  const ac = syncAutocomplete("/s", 2, ITEMS);
  const f = renderFrame(base({ state: initialTuiState({ input: "/s", cursor: 2, ac }) }));
  // first lines are dropdown rows (contain command names), box comes after
  const boxTop = f.lines.findIndex((l) => l.includes("╭"));
  assert.ok(boxTop >= 1, "dropdown occupies rows above the box");
  assert.ok(strip(f.lines.slice(0, boxTop).join("\n")).includes("scan"));
  assert.equal(f.cursorRow, boxTop + 1);
});

test("bypass mode tints the box border danger (red)", () => {
  const f = renderFrame(
    base({ caps: "truecolor", state: initialTuiState({ permMode: "bypassPermissions" }) }),
  );
  // the danger role (red.400 #f85149-ish) appears on the top border line
  assert.match(f.lines[0] ?? "", /38;2;/);
  // and the bypass indicator shows in the status block
  assert.ok(f.lines.some((l) => strip(l).includes("⏵⏵ bypass permissions on")));
});

test("narrow terminal collapses to a single prompt line", () => {
  const f = renderFrame(base({ cols: 18, state: initialTuiState({ input: "hi", cursor: 2 }) }));
  assert.equal(f.lines.length, 1);
  assert.equal(strip(f.lines[0] ?? ""), "› hi");
  assert.equal(f.cursorCol, 4); // "› " + caret 2
  assert.equal(f.cursorRow, 0);
});

test("narrow collapse clamps a long line to cols-1 + the caret within bounds", () => {
  const f = renderFrame(
    base({ cols: 18, state: initialTuiState({ input: "x".repeat(100), cursor: 100 }) }),
  );
  assert.equal(f.lines.length, 1);
  assert.ok([...strip(f.lines[0] ?? "")].length <= 18 - 1, "collapsed line never exceeds cols-1");
  assert.ok(f.cursorCol <= 18 - 1, "caret stays on-screen");
});

/* ── the model trait strip / panel, end to end ──────────────────────────────*/

/** gemma4:12b as the live daemon reports it: 5 capabilities + the effort dial = 6 traits. */
const GEMMA4_STATUS: StatusModel = {
  ...STATUS,
  model: "gemma4:12b",
  capabilities: ["completion", "vision", "audio", "tools", "thinking"],
  effort: { tier: "max", available: true, degraded: false },
};

test("the trait rail is ONE row, in fixed slot order, with the dial last", () => {
  const f = renderFrame(base({ status: GEMMA4_STATUS, cols: 80, rows: 24 }));
  const lines = f.lines.map(strip);
  const rule = lines.findIndex((l) => l.startsWith("\u251c"));
  assert.ok(rule > 0, "no rail rule was rendered");
  assert.match(lines[rule + 1] ?? "", /txt\s+vis\s+aud\s+tool\s+think\s+\u2699 max/);
  assert.ok(
    (lines[rule + 2] ?? "").startsWith("\u2570"),
    "the bottom border must follow the rail directly — the rail is a SINGLE row",
  );
});

test("a capability the model LACKS keeps its slot instead of vanishing", () => {
  // The whole point of a fixed rail: absence is information, and a row whose cells never move
  // is one the eye (and the arrow keys) can learn. The old strip could only list what was there.
  const f = renderFrame(
    base({
      status: {
        ...STATUS,
        capabilities: ["completion", "tools"],
        effort: { tier: "high", available: true, degraded: false },
      },
      cols: 80,
    }),
  );
  const lines = f.lines.map(strip);
  const rule = lines.findIndex((l) => l.startsWith("\u251c"));
  assert.ok(rule > 0);
  assert.match(
    lines[rule + 1] ?? "",
    /txt\s+vis\s+aud\s+tool\s+think\s+\u2699 high/,
    "vis/aud/think must still occupy their slots (dimmed) on a text-only model",
  );
});

test("a terminal too SHORT for the rail falls back to the dial alone, never to nothing", () => {
  // The rail costs 2 rows (rule + rail) on top of the box's own 3 and the status bar's 2 — one
  // row cheaper than the two-row grid it replaced. When it does not fit the user still needs the
  // one trait they can act on; showing nothing would be the same class of bug as "not available".
  assert.ok(
    renderFrame(base({ status: GEMMA4_STATUS, cols: 80, rows: 8 }))
      .lines.map(strip)
      .some((l) => l.startsWith("\u251c")),
    "8 rows must still afford the rail — otherwise this test asserts the wrong boundary",
  );
  const f = renderFrame(base({ status: GEMMA4_STATUS, cols: 80, rows: 6 }));
  const lines = f.lines.map(strip);
  assert.equal(
    lines.some((l) => l.startsWith("\u251c")),
    false,
    "the rail must not be rendered when there is no room for it",
  );
  assert.ok(
    lines.some((l) => /effort: max/.test(l)),
    "the dial must survive the fallback",
  );
});

test("the rail fits an 80-col terminal at HALF width, where the old grid gave up", () => {
  // 35 columns for six cells, against a 3-column grid that needed its widest cell to fit whole
  // in a third of the width and declined outright at 40 columns.
  const f = renderFrame(base({ status: GEMMA4_STATUS, cols: 40, rows: 24 }));
  const lines = f.lines.map(strip);
  const rule = lines.findIndex((l) => l.startsWith("\u251c"));
  assert.ok(rule > 0, "the rail must survive a 40-column terminal");
  assert.match(lines[rule + 1] ?? "", /txt\s+vis\s+aud\s+tool\s+think/);
});

test("a terminal too narrow even for the rail declines rather than clipping it", () => {
  const f = renderFrame(base({ status: GEMMA4_STATUS, cols: 24, rows: 24 }));
  const lines = f.lines.map(strip);
  assert.equal(
    lines.some((l) => l.startsWith("\u251c")),
    false,
    "half a rail reads as a rendering bug, not as information",
  );
});

test("the panel never breaks the width rule at any terminal size", () => {
  for (const cols of [40, 60, 80, 100, 120, 200]) {
    for (const rows of [10, 16, 24, 50]) {
      const f = renderFrame(base({ status: GEMMA4_STATUS, cols, rows }));
      for (const line of f.lines) {
        assert.ok(
          strip(line).length <= cols - 1,
          `cols=${cols} rows=${rows}: a line touched the last column`,
        );
      }
    }
  }
});

test("the panel does not move the caret or the click-to-position geometry", () => {
  const withPanel = renderFrame(base({ status: GEMMA4_STATUS, cols: 80, rows: 24 }));
  const without = renderFrame(base({ status: STATUS, cols: 80, rows: 24 }));
  assert.equal(withPanel.cursorRow, without.cursorRow);
  assert.equal(withPanel.cursorCol, without.cursorCol);
  assert.deepEqual(withPanel.box, without.box);
});

test("the frame never exceeds `rows` — the panel yields to an overlay that owns them", () => {
  // The sibling of the width rule: `lines.length === physical rows` is what the redraw math
  // depends on. `room` used to subtract only `dropdown.length`, ignoring the /invoke overlay
  // and the reverse-i-search line entirely. That under-count was survivable while the composer
  // was three lines; the trait panel adds three more, and with an overlay open the frame
  // overran `rows` by exactly the panel's height.
  const items = Array.from({ length: 12 }, (_, i) => ({ name: `cmd${i}`, summary: `s${i}` }));
  const states = {
    plain: initialTuiState(),
    search: { ...initialTuiState(), search: { query: "q", matchIndex: -1, failing: true } },
    overlay: { ...initialTuiState(), invokeOverlay: openInvokeOverlay(items) },
  };
  for (const rows of [10, 12, 16, 20, 24, 40]) {
    for (const [label, state] of Object.entries(states)) {
      const f = renderFrame(base({ state, status: GEMMA4_STATUS, cols: 100, rows }));
      assert.ok(
        f.lines.length <= rows,
        `${label} at rows=${rows}: frame is ${f.lines.length} lines, over by ${f.lines.length - rows}`,
      );
    }
  }
});

test("with room to spare the panel still renders — the fix bounds it, it does not disable it", () => {
  const f = renderFrame(base({ status: GEMMA4_STATUS, cols: 100, rows: 40 }));
  assert.ok(
    f.lines.map(strip).some((l) => l.startsWith("\u251c")),
    "a tall terminal must still get the panel",
  );
});

test("the frame reports the rail's screen geometry, so a CLICK can hit a cell", () => {
  // The mouse twin of ⌃T. Spans come from the same `cells` array the rail is painted from, so
  // the click target cannot drift from what is on screen.
  const f = renderFrame(base({ status: GEMMA4_STATUS, cols: 80, rows: 24 }));
  assert.ok(f.rail, "a rendered rail must expose its geometry");
  const lines = f.lines.map(strip);
  assert.match(lines[f.rail.row] ?? "", /txt\s+vis\s+aud\s+tool\s+think/);
  assert.equal(f.rail.spans.length, 6, "five capability slots + the dial");
  // contiguous, ascending, and starting at the rail's own origin
  assert.equal(f.rail.spans[0]?.start, 0);
  for (let i = 1; i < f.rail.spans.length; i++) {
    assert.equal(f.rail.spans[i]?.start, f.rail.spans[i - 1]?.end);
  }
  // the `tool` cell's span must actually cover the word on the painted line
  const railLine = lines[f.rail.row] ?? "";
  const span = f.rail.spans[3] as { start: number; end: number };
  const painted = railLine.slice(f.rail.textLeft + span.start, f.rail.textLeft + span.end);
  assert.match(painted, /tool/);
});

test("no rail rendered ⇒ no rail geometry (a click can never target a row that is not there)", () => {
  const f = renderFrame(base({ status: GEMMA4_STATUS, cols: 80, rows: 6 }));
  assert.equal(f.rail, undefined);
});

test("the frame never exceeds `rows` in ANY permission mode — the indicator is a third status line", () => {
  /**
   * `statusLines` emits [status bar, indicator?, key hint] — two lines by default and THREE
   * whenever a non-default mode is active. The composer's budget subtracted a fixed 4, so in
   * acceptEdits / plan / bypassPermissions / yolo the frame came out one line taller than the
   * terminal at exactly the height where the composer is already at its minimum: a 7-row
   * terminal rendered 8 lines, breaking the `lines.length === physical rows` invariant the
   * redraw math depends on.
   */
  for (const permMode of ["default", "acceptEdits", "plan", "bypassPermissions", "yolo"] as const) {
    for (let rows = 3; rows <= 30; rows++) {
      for (const cols of [40, 80, 120]) {
        const f = renderFrame(
          base({
            status: { ...GEMMA4_STATUS, permMode },
            cols,
            rows,
            state: initialTuiState({ permMode }),
          }),
        );
        assert.ok(
          f.lines.length <= rows,
          `${permMode} at ${cols}x${rows} rendered ${f.lines.length} lines`,
        );
      }
    }
  }
});

test("a picker overlay never makes the frame taller than the terminal, in ANY permission mode", () => {
  /**
   * Both overlays were sized `Math.max(4, rows - 5)`, reserving 3 composer + 2 status rows.
   * `statusLines` emits a THIRD — the permission-mode indicator — in acceptEdits / plan /
   * bypassPermissions / yolo. The composer budget further down already subtracted that row, but
   * it floors at one body row, so the extra line was never absorbed and the frame came out at
   * rows + 1, breaking the `lines.length === physical rows` invariant the redraw depends on.
   *
   * The overrun depends on the overlay actually consuming its cap, so this sweeps item counts as
   * well as heights: a long list (like /commands' ~170 rows) overruns at every height, a short
   * one only at a few.
   */
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `item-${i}`, submitText: `/x${i}` }));

  for (const permMode of ["default", "acceptEdits", "plan", "bypassPermissions", "yolo"] as const) {
    for (const count of [5, 16, 170]) {
      const all = items(count);
      for (let rows = 6; rows <= 40; rows++) {
        const f = renderFrame(
          base({
            rows,
            cols: 100,
            state: {
              ...initialTuiState(),
              permMode,
              listOverlay: { title: "pick", all, filtered: all, index: 0, query: "" },
            },
          }),
        );
        assert.ok(
          f.lines.length <= rows,
          `${permMode} · ${count} items · rows=${rows}: frame is ${f.lines.length} lines`,
        );
      }
    }
  }
});
