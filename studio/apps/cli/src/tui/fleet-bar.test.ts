/**
 * tui/fleet-bar.test.ts — the bar, its width ladder, and the guards that keep it honest.
 *
 * Three classes of test here. The RENDERING tests pin what a user sees. The LADDER tests pin
 * what they see when the terminal is too narrow for all of it. The DRIFT GUARDS pin the three
 * places where a second copy of a decision would silently break the first — the frame's height
 * budget, the two CLI hosts, and the slash registry's name space.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CELL_FREE,
  CELL_OTHER,
  CELL_OURS,
  type FleetBarModel,
  barCells,
  fleetBarLine,
  fleetBarRows,
  fleetLegendLines,
  meterPiece,
  peerPieces,
} from "./fleet-bar.js";
import { stringWidth } from "./width.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const src = (rel: string): string => readFileSync(join(import.meta.dirname, rel), "utf8");
/** Source with comments stripped — a guard must match CODE, never a comment quoting the code. */
const code = (rel: string): string =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const model = (over: Partial<FleetBarModel> = {}): FleetBarModel => ({
  peers: { working: 3, idle: 2, needsYou: 1, dead: 1, total: 7 },
  cpu: { pct: 41, oursPct: 28 },
  ram: { pct: 34, oursPct: 9 },
  gpu: { pct: 68 },
  ...over,
});

/* ── cells ───────────────────────────────────────────────────────────────────*/

test("the three segments always sum to exactly n", () => {
  for (let pct = 0; pct <= 100; pct += 7) {
    for (let ours = 0; ours <= pct; ours += 11) {
      for (const n of [3, 4, 6]) {
        const c = barCells(pct, ours, n);
        assert.equal(c.ours + c.other + c.free, n, `pct=${pct} ours=${ours} n=${n}`);
      }
    }
  }
});

test("a NON-ZERO Prometheus share always claims at least one cell", () => {
  // 6 GB of 64 is 9%: under a sixth of a six-cell bar, so plain rounding gives it zero cells and
  // the fleet vanishes from the bar whose entire job is showing the fleet.
  assert.equal(barCells(34, 9, 6).ours, 1);
  assert.equal(barCells(100, 1, 6).ours, 1);
  assert.equal(barCells(50, 0.4, 3).ours, 1);
});

test("a zero share claims no cell — the minimum is not a floor of one", () => {
  assert.equal(barCells(41, 0, 6).ours, 0);
});

test("a saturated machine shows no free cells", () => {
  const c = barCells(100, 20, 6);
  assert.equal(c.free, 0);
  assert.equal(c.ours + c.other, 6);
});

test("an idle machine is all free", () => {
  assert.deepEqual(barCells(0, 0, 6), { ours: 0, other: 0, free: 6 });
});

test("ours is clamped to the total — a stale probe cannot draw more than exists", () => {
  const c = barCells(20, 90, 6);
  assert.ok(c.ours <= 6);
  assert.equal(c.ours + c.other + c.free, 6);
});

test("zero cells means no bar at all", () => {
  assert.deepEqual(barCells(41, 28, 0), { ours: 0, other: 0, free: 0 });
});

/* ── one meter ───────────────────────────────────────────────────────────────*/

test("a meter with a known split draws the bar", () => {
  const p = meterPiece("cpu", { pct: 41, oursPct: 28 }, 6, "none");
  assert.equal(p.plain, `cpu ${CELL_OURS.repeat(2)}${CELL_OTHER}${CELL_FREE.repeat(3)} 41%`);
});

test("a meter with NO split draws no bar — the absence is the answer", () => {
  // This is the Apple Silicon GPU case, and the rule the whole module is built around: never
  // render a split we did not measure.
  assert.equal(meterPiece("gpu", { pct: 68 }, 6, "none").plain, "gpu 68%");
});

test("a present-but-unmeasurable unit reads as an em dash, never as 0%", () => {
  assert.equal(meterPiece("gpu", { pct: null }, 6, "none").plain, "gpu —");
});

test("zero cells keeps the number", () => {
  assert.equal(meterPiece("ram", { pct: 34, oursPct: 9 }, 0, "none").plain, "ram 34%");
});

test("the percentage warns at 80 and alarms at 95", () => {
  const at = (pct: number): string => meterPiece("cpu", { pct }, 0, "truecolor").colored;
  assert.notEqual(at(79), at(85), "80% must not paint the same as 79%");
  assert.notEqual(at(85), at(96), "95% must not paint the same as 85%");
});

/* ── peer chips ──────────────────────────────────────────────────────────────*/

test("zero-count chips are hidden — a healthy fleet is short", () => {
  const plain = peerPieces(
    model({ peers: { working: 1, idle: 2, needsYou: 0, dead: 0, total: 3 } }),
    "none",
  ).map((p) => p.plain);
  assert.deepEqual(plain, ["prom 3", "working 1", "idle 2"]);
});

test("every number carries a word — nothing on this line needs a decoder", () => {
  for (const p of peerPieces(model(), "none")) {
    assert.match(p.plain, /^[a-z-]+ \d+$/, `undecodable chip: ${p.plain}`);
  }
});

test("chip ORDER never depends on the counts", () => {
  const order = (m: FleetBarModel): string[] =>
    peerPieces(m, "none").map((p) => p.plain.split(" ")[0] as string);
  // A chip that moves position between refreshes has to be re-found by eye every time.
  assert.deepEqual(order(model()), ["prom", "working", "idle", "needs-you", "dead"]);
  assert.deepEqual(
    order(model({ peers: { working: 0, idle: 0, needsYou: 9, dead: 1, total: 10 } })),
    ["prom", "needs-you", "dead"],
  );
});

/* ── the line ────────────────────────────────────────────────────────────────*/

test("a fleet of ONE renders nothing — a solo user pays no terminal height", () => {
  const alone = model({ peers: { working: 1, idle: 0, needsYou: 0, dead: 0, total: 1 } });
  assert.equal(fleetBarLine(alone, 100, "none"), null);
  assert.equal(fleetBarRows(alone, 100), 0);
});

test("…and a second window brings it back", () => {
  const two = model({ peers: { working: 1, idle: 1, needsYou: 0, dead: 0, total: 2 } });
  assert.ok(fleetBarLine(two, 100, "none"));
  assert.equal(fleetBarRows(two, 100), 1);
});

test("the rendered line is EXACTLY the width it was given, at every width", () => {
  // An over-long status line wraps, and a wrapped status line pushes the composer off the
  // bottom of the terminal — frame.ts carries two separate scars from exactly that.
  for (let w = 20; w <= 160; w++) {
    const line = fleetBarLine(model(), w, "none");
    assert.ok(line !== null);
    assert.ok(stringWidth(line) <= w, `width ${w} overflowed: ${stringWidth(line)}`);
  }
});

test("the ladder shrinks the BARS before it drops a meter", () => {
  const at = (w: number): string => strip(fleetBarLine(model(), w, "none") as string);
  assert.match(at(120), /cpu \S{6} 41%/, "6 cells when there is room");
  assert.match(at(84), /cpu \S{4} 41%/, "4 cells");
  assert.match(at(81), /cpu \S{3} 41%/, "3 cells");
  assert.match(at(75), /cpu 41%/, "no bar — but still a number");
  // …and all three meters survive every one of those rungs. A dropped meter answers nothing;
  // a number with no bar still answers "how loaded".
  for (const w of [120, 84, 81, 75]) assert.match(at(w), /gpu/, `gpu dropped at ${w}`);
});

test("…and drops the presence badges first of all", () => {
  const m = model({ accelerators: ["ane"] });
  assert.match(strip(fleetBarLine(m, 140, "none") as string), /ane present/);
  // A static fact that never changes during a session costs width on every frame to say the
  // same thing, and `/fleet` carries it anyway.
  assert.doesNotMatch(strip(fleetBarLine(m, 99, "none") as string), /ane present/);
  assert.match(strip(fleetBarLine(m, 99, "none") as string), /gpu 68%/);
});

test("the peer chips are the LAST thing to go", () => {
  const narrow = strip(fleetBarLine(model(), 46, "none") as string);
  assert.match(narrow, /prom 7/);
  assert.match(narrow, /needs-you 1/);
});

test("a terminal too narrow for anything still says who is out there", () => {
  const tiny = strip(fleetBarLine(model(), 24, "none") as string);
  assert.match(tiny, /^prom 7/);
});

test("clipping never cuts inside an escape sequence", () => {
  // Clipping the COLOURED string instead of the plain one leaves a dangling SGR introducer,
  // which paints the rest of the terminal light blue until something resets it.
  const tiny = fleetBarLine(model(), 18, "truecolor") as string;
  assert.ok(tiny.endsWith("\x1b[0m") || !tiny.includes("\x1b["), tiny);
});

/* ── colour ──────────────────────────────────────────────────────────────────*/

test("the three cells take three DIFFERENT colours", () => {
  const colored = meterPiece("cpu", { pct: 60, oursPct: 20 }, 6, "truecolor").colored;
  const sgrFor = (glyph: string): string => {
    const m = new RegExp(`\\x1b\\[([0-9;]*)m${glyph}`).exec(colored);
    return m?.[1] ?? "";
  };
  const ours = sgrFor(CELL_OURS);
  const other = sgrFor(CELL_OTHER);
  const free = sgrFor(CELL_FREE);
  assert.ok(ours && other && free, `missing a painted cell in ${JSON.stringify(colored)}`);
  assert.equal(new Set([ours, other, free]).size, 3);
  // …and they are the hues the legend promises: Prometheus light blue, other yellow, free green.
  assert.match(ours, /38;2;22;179;245/, "Prometheus cells are the operator light blue #16b3f5");
  const rgb = (s: string): number[] =>
    (/38;2;(\d+);(\d+);(\d+)/.exec(s)?.slice(1) ?? []).map(Number);
  const [or, og, ob] = rgb(other);
  assert.ok(
    (or as number) > 200 && (og as number) > 150 && (ob as number) < 130,
    `other not yellow: ${other}`,
  );
  const [fr, fg, fb] = rgb(free);
  assert.ok(
    (fg as number) > (fr as number) && (fg as number) > (fb as number),
    `free not green: ${free}`,
  );
});

test("NO_COLOR loses the hues and none of the meaning", () => {
  const plain = fleetBarLine(model(), 110, "none") as string;
  assert.doesNotMatch(plain, /\x1b\[/);
  assert.match(plain, /needs-you 1/);
  assert.match(plain, /dead 1/);
});

/* ── legend ──────────────────────────────────────────────────────────────────*/

test("the legend explains all three glyphs, from the same constants the bar draws", () => {
  const text = strip(fleetLegendLines("none").join("\n"));
  for (const glyph of [CELL_OURS, CELL_OTHER, CELL_FREE]) {
    assert.ok(text.includes(glyph), `the legend never shows ${glyph}`);
  }
  assert.match(text, /Prometheus/);
  assert.match(text, /other processes/);
  assert.match(text, /free/);
});

test("the legend names every state the bar can show", () => {
  const text = strip(fleetLegendLines("none").join("\n"));
  for (const word of ["working", "idle", "needs you", "dead"]) {
    assert.ok(text.includes(word), `the legend never explains "${word}"`);
  }
});

test("the legend admits that a missing bar is a real state", () => {
  assert.match(strip(fleetLegendLines("none").join("\n")), /not measurable/);
});

test("the legend points at a command that exists", () => {
  const text = strip(fleetLegendLines("none").join("\n"));
  const named = /\/(\w+)/.exec(text)?.[1];
  assert.equal(named, "fleet");
  const registry = code("../session/slash-registry.ts");
  assert.match(registry, /name: "fleet"/, "the legend tells the user to run a command we removed");
});

/* ── drift guards ────────────────────────────────────────────────────────────*/

test("GUARD: the frame's height budget uses the SAME predicate as the renderer", () => {
  // Two copies of "will there be a fleet line" is a frame that paints one row more than the
  // terminal has, which walks the prompt up the screen over the scrollback.
  const frame = code("./frame.ts");
  assert.match(frame, /fleetBarRows\(status\.fleet, width\)/);
  assert.match(frame, /const room = rows - lines\.length - 4 - extraStatusRows;/);
  assert.match(frame, /const overlayRows = rows - 5 - extraStatusRows;/);
  assert.doesNotMatch(frame, /rows - lines\.length - 4 - indicatorRows/);
});

test("GUARD: BOTH CLI hosts register a heartbeat", () => {
  // A window running the readline host would otherwise be missing from every other window's
  // count — the fleet bar's own subject, silently wrong on half the surfaces.
  for (const host of ["./session-bridge.ts", "../session/host.ts"]) {
    assert.match(code(host), /startFleetTicker\(\{/, `${host} never joins the fleet`);
  }
});

test("GUARD: BOTH CLI hosts paint the bar through this renderer", () => {
  assert.match(code("./status.ts"), /fleetBarLine\(m\.fleet, width, caps\)/);
  assert.match(
    code("../session/host.ts"),
    /fleetBarLine\(fleet\.model, fleet\.width, fleet\.caps\)/,
  );
});

test("GUARD: BOTH CLI hosts answer /fleet", () => {
  for (const host of ["./session-bridge.ts", "../session/host.ts"]) {
    assert.match(code(host), /fleet: async \(\) =>/, `${host} has no /fleet projector`);
  }
});

test("GUARD: BOTH CLI hosts flip to needs-you around a prompt", () => {
  for (const host of ["./session-bridge.ts", "../session/host.ts"]) {
    assert.match(code(host), /fleetState\("needs-you"\)/, `${host} never reports needs-you`);
  }
  // …and the bridge routes EVERY prompt through the wrapper rather than the raw dep, because
  // `deps.confirm` alone has fifteen call sites and one forgotten site is a permanently wrong state.
  const bridge = code("./session-bridge.ts");
  const rawUses = bridge.match(/deps\.(confirm|confirmPhrase|ask|askPath)\b/g) ?? [];
  assert.equal(rawUses.length, 4, `un-wrapped prompt call sites: ${rawUses.join(", ")}`);
});

test("GUARD: every host that reports `working` also reports `idle`", () => {
  // `whileBlocked` hands a window back to `working` when a prompt closes. A host that sets
  // `working` around its prompts but has no owner returning it to `idle` latches as busy after
  // the first `[y/N]`, forever — which is exactly what the readline host did until a live
  // two-window run caught it. Both halves, or the state machine has no exit.
  for (const host of ["./session-bridge.ts", "../session/host.ts"]) {
    const src2 = code(host);
    assert.match(src2, /fleetState\("working"\)/, `${host} never reports working`);
    assert.match(src2, /fleetState\("idle"\)/, `${host} never returns to idle`);
    // …and the return has to be unconditional, not on the happy path only.
    assert.match(
      src2,
      /finally \{\s*fleetState\("idle"\);\s*\}/,
      `${host} does not return to idle in a finally`,
    );
  }
});

test("GUARD: no two slash commands claim the same name", () => {
  // The registry's own comment records that its lookup map has NO duplicate-key guard, so a
  // collision loses silently to whichever entry is built last. `/fleet` was an alias of
  // `/demos` before it was a command.
  const registry = src("../session/slash-registry.ts");
  const names = [...registry.matchAll(/^ {4}name: "([^"]+)",$/gm)].map((m) => m[1] as string);
  const aliases = [...registry.matchAll(/^ {4}aliases: \[([^\]]+)\],$/gm)].flatMap((m) =>
    [...(m[1] as string).matchAll(/"([^"]+)"/g)].map((a) => a[1] as string),
  );
  assert.ok(
    names.length > 50,
    `the name scan found only ${names.length} commands — pattern rotted`,
  );
  const seen = new Map<string, number>();
  for (const n of [...names, ...aliases]) seen.set(n, (seen.get(n) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(dupes, [], `duplicate slash identifiers: ${dupes.join(", ")}`);
});
