/**
 * breakpoint-store.test.ts — node:test for the PURE breakpoint model (APP-012).
 *
 * Pins the toggle/enable/remove/clearFile reducers (same-ref no-op contract),
 * the 1-based line passthrough (NO ±1 conversion anywhere), the DAP-shaped
 * selectors (REPLACE-ALL enabled list, affected-path diffing that surfaces an
 * emptied source but NOT verified-only changes), the response fold-back
 * (verified + adapter-ADJUSTED lines, index-correlated, collision collapse),
 * the launch-time replay ordering, the uri↔path helpers, and the persistence
 * codec round-trip. Pure — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BREAKPOINT_GLYPH_ORDER,
  BREAKPOINT_PROVIDER,
  type BreakpointsState,
  allBreakpoints,
  applySetBreakpointsResponse,
  breakpointDetail,
  breakpointGlyphClass,
  clearFile,
  dapAffectedPaths,
  dapLaunchPlan,
  deserializeBreakpoints,
  fileUriToPath,
  gutterDecorationsFor,
  initialBreakpointsState,
  isConditional,
  isLogpoint,
  normalizeBreakpointPath,
  pathToFileUri,
  removeBreakpoint,
  replayBreakpoints,
  serializeBreakpoints,
  setBreakpointEnabled,
  toDapSourceBreakpoints,
  toggleBreakpoint,
  updateBreakpoint,
  useBreakpointStore,
  wireBreakpointGutter,
} from "./breakpoint-store.js";
import { createGutterRegistry } from "./gutter-decorations.js";

const A = "/ws/a.py";
const B = "/ws/b.py";

/** A deterministic id minter per test. */
function minter(): () => string {
  let n = 0;
  return () => `t-${++n}`;
}

/* ── toggle / setEnabled / remove / clearFile ─────────────────────────────────*/

test("toggle adds an enabled breakpoint at the exact 1-based line", () => {
  const s = toggleBreakpoint(initialBreakpointsState(), A, 7, minter());
  assert.deepEqual(s[A], [{ id: "t-1", path: A, line: 7, enabled: true }]);
});

test("toggle on an existing line removes it (even when disabled) and drops an emptied file key", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 7, mint);
  s = setBreakpointEnabled(s, A, 7, false);
  s = toggleBreakpoint(s, A, 7, mint);
  assert.equal(A in s, false);
});

test("toggle keeps a file's list sorted by line", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 9, mint);
  s = toggleBreakpoint(s, A, 3, mint);
  s = toggleBreakpoint(s, A, 5, mint);
  assert.deepEqual(
    s[A]?.map((b) => b.line),
    [3, 5, 9],
  );
});

test("toggle mints a distinct id per breakpoint (ours, never the adapter's)", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 1, mint);
  s = toggleBreakpoint(s, B, 1, mint);
  const ids = allBreakpoints(s).map((b) => b.id);
  assert.equal(new Set(ids).size, 2);
});

test("setEnabled flips the flag; same value / unknown line are same-ref no-ops", () => {
  const s = toggleBreakpoint(initialBreakpointsState(), A, 7, minter());
  const off = setBreakpointEnabled(s, A, 7, false);
  assert.equal(off[A]?.[0]?.enabled, false);
  assert.equal(setBreakpointEnabled(off, A, 7, false), off);
  assert.equal(setBreakpointEnabled(off, A, 99, true), off);
  assert.equal(setBreakpointEnabled(off, "/nope.py", 1, true), off);
});

test("removeBreakpoint drops the line; absent line is a same-ref no-op", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 7, mint);
  s = toggleBreakpoint(s, A, 9, mint);
  const r = removeBreakpoint(s, A, 7);
  assert.deepEqual(
    r[A]?.map((b) => b.line),
    [9],
  );
  assert.equal(removeBreakpoint(r, A, 7), r);
});

test("clearFile drops a whole file; unknown file is a same-ref no-op", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 7, mint);
  s = toggleBreakpoint(s, B, 2, mint);
  const r = clearFile(s, A);
  assert.equal(A in r, false);
  assert.deepEqual(
    r[B]?.map((b) => b.line),
    [2],
  );
  assert.equal(clearFile(r, A), r);
});

/* ── DAP-shaped selectors ─────────────────────────────────────────────────────*/

test("toDapSourceBreakpoints emits the FULL enabled list as SourceBreakpoint[] (sorted, 1-based passthrough)", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 9, mint);
  s = toggleBreakpoint(s, A, 3, mint);
  s = toggleBreakpoint(s, A, 5, mint);
  s = setBreakpointEnabled(s, A, 5, false);
  assert.deepEqual(toDapSourceBreakpoints(s, A), [{ line: 3 }, { line: 9 }]);
  assert.deepEqual(toDapSourceBreakpoints(s, "/unknown.py"), []);
});

test("allBreakpoints flattens sorted by path then line", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), B, 4, mint);
  s = toggleBreakpoint(s, A, 9, mint);
  s = toggleBreakpoint(s, A, 2, mint);
  assert.deepEqual(
    allBreakpoints(s).map((b) => `${b.path}:${b.line}`),
    ["/ws/a.py:2", "/ws/a.py:9", "/ws/b.py:4"],
  );
});

test("dapAffectedPaths: add / remove / enable-flip surface the path; identical refs short-circuit", () => {
  const mint = minter();
  const s0 = initialBreakpointsState();
  const s1 = toggleBreakpoint(s0, A, 7, mint);
  assert.deepEqual(dapAffectedPaths(s0, s1), [A]);
  const s2 = setBreakpointEnabled(s1, A, 7, false);
  assert.deepEqual(dapAffectedPaths(s1, s2), [A]);
  assert.deepEqual(dapAffectedPaths(s1, s1), []);
});

test("dapAffectedPaths surfaces an EMPTIED source (its `breakpoints: []` must still be sent)", () => {
  const mint = minter();
  const s1 = toggleBreakpoint(initialBreakpointsState(), A, 7, mint);
  const s2 = removeBreakpoint(s1, A, 7);
  assert.deepEqual(dapAffectedPaths(s1, s2), [A]);
});

test("dapAffectedPaths ignores changes DAP can't see (verified fold-back, disabled-only edits)", () => {
  const mint = minter();
  let s1 = toggleBreakpoint(initialBreakpointsState(), A, 7, mint);
  const s2 = applySetBreakpointsResponse(s1, A, [7], [{ verified: true }]);
  assert.deepEqual(dapAffectedPaths(s1, s2), []);
  // removing a DISABLED breakpoint never changes what the adapter sees.
  s1 = toggleBreakpoint(s1, A, 9, mint);
  s1 = setBreakpointEnabled(s1, A, 9, false);
  const s3 = removeBreakpoint(s1, A, 9);
  assert.deepEqual(dapAffectedPaths(s1, s3), []);
});

/* ── response fold-back ───────────────────────────────────────────────────────*/

test("applySetBreakpointsResponse sets verified by request index", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 3, mint);
  s = toggleBreakpoint(s, A, 9, mint);
  const r = applySetBreakpointsResponse(s, A, [3, 9], [{ verified: true }, { verified: false }]);
  assert.deepEqual(
    r[A]?.map((b) => [b.line, b.verified]),
    [
      [3, true],
      [9, false],
    ],
  );
});

test("applySetBreakpointsResponse keeps the adapter's ADJUSTED line, not the requested one", () => {
  const s = toggleBreakpoint(initialBreakpointsState(), A, 3, minter());
  const r = applySetBreakpointsResponse(s, A, [3], [{ verified: true, line: 5 }]);
  assert.deepEqual(
    r[A]?.map((b) => [b.line, b.verified]),
    [[5, true]],
  );
  // our id survives the adjustment — adapter ids are never adopted.
  assert.equal(r[A]?.[0]?.id, s[A]?.[0]?.id);
});

test("an adjustment landing on another breakpoint's line collapses the pair", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 3, mint);
  s = toggleBreakpoint(s, A, 5, mint);
  const r = applySetBreakpointsResponse(
    s,
    A,
    [3, 5],
    [{ verified: true, line: 5 }, { verified: true }],
  );
  assert.deepEqual(
    r[A]?.map((b) => b.line),
    [5],
  );
});

test("applySetBreakpointsResponse skips disabled breakpoints and is same-ref on no change / junk", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 3, mint);
  s = toggleBreakpoint(s, A, 9, mint);
  s = setBreakpointEnabled(s, A, 3, false);
  // only line 9 was sent; the disabled 3 must be untouched by index correlation.
  const r = applySetBreakpointsResponse(s, A, [9], [{ verified: true }]);
  assert.equal(r[A]?.find((b) => b.line === 3)?.verified, undefined);
  assert.equal(r[A]?.find((b) => b.line === 9)?.verified, true);
  // replaying the identical response is a same-ref no-op (no resend feedback loop).
  assert.equal(applySetBreakpointsResponse(r, A, [9], [{ verified: true }]), r);
  assert.equal(applySetBreakpointsResponse(r, A, [9], ["junk", 42]), r);
  assert.equal(applySetBreakpointsResponse(r, "/unknown.py", [1], [{ verified: true }]), r);
});

/* ── launch-time replay ───────────────────────────────────────────────────────*/

test("replayBreakpoints sends every source WITH enabled breakpoints, in path order, awaited", async () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), B, 4, mint);
  s = toggleBreakpoint(s, A, 2, mint);
  s = toggleBreakpoint(s, "/ws/c.py", 1, mint);
  s = setBreakpointEnabled(s, "/ws/c.py", 1, false); // all-disabled → skipped
  const calls: string[] = [];
  await replayBreakpoints(s, async (path, bps) => {
    calls.push(`${path}=${bps.map((b) => b.line).join("|")}`);
  });
  assert.deepEqual(calls, ["/ws/a.py=2", "/ws/b.py=4"]);
});

/* ── uri↔path + path normalization ────────────────────────────────────────────*/

test("pathToFileUri follows the house raw file:// convention (idempotent)", () => {
  assert.equal(pathToFileUri("/ws/a.py"), "file:///ws/a.py");
  assert.equal(pathToFileUri("file:///ws/a.py"), "file:///ws/a.py");
});

test("fileUriToPath decodes Monaco's percent-encoded model form; non-file schemes → null", () => {
  assert.equal(fileUriToPath("file:///ws/a.py"), "/ws/a.py");
  assert.equal(fileUriToPath("file:///ws/my%20file.py"), "/ws/my file.py");
  assert.equal(fileUriToPath("scratch:untitled-1"), null);
  assert.equal(fileUriToPath("untitled:one"), null);
});

test("normalizeBreakpointPath lowercases only a leading drive letter", () => {
  assert.equal(normalizeBreakpointPath("C:/ws/a.py"), "c:/ws/a.py");
  assert.equal(normalizeBreakpointPath("/C:/ws/a.py"), "/c:/ws/a.py");
  assert.equal(normalizeBreakpointPath("/Users/X/a.py"), "/Users/X/a.py");
});

test("lines are 1-based end-to-end: what goes in is what DAP gets (no ±1 anywhere)", () => {
  const s = toggleBreakpoint(initialBreakpointsState(), A, 1, minter());
  assert.deepEqual(toDapSourceBreakpoints(s, A), [{ line: 1 }]);
});

/* ── persistence codec ────────────────────────────────────────────────────────*/

test("serialize→deserialize round-trips lines + enabled, minting fresh ids, dropping verified", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 3, mint);
  s = toggleBreakpoint(s, A, 9, mint);
  s = setBreakpointEnabled(s, A, 9, false);
  s = applySetBreakpointsResponse(s, A, [3], [{ verified: true }]);
  const blob = JSON.parse(JSON.stringify(serializeBreakpoints(s))) as unknown;
  const r = deserializeBreakpoints(blob, minter());
  assert.deepEqual(
    r[A]?.map((b) => [b.line, b.enabled, b.verified]),
    [
      [3, true, undefined],
      [9, false, undefined],
    ],
  );
});

test("deserializeBreakpoints drops junk fail-soft: bad lines, dupes, non-arrays, non-objects", () => {
  const r = deserializeBreakpoints(
    {
      [A]: [
        { line: 2 },
        { line: 2 },
        { line: 0 },
        { line: 1.5 },
        "junk",
        { line: 4, enabled: false },
      ],
      "/empty.py": [],
      "/bad.py": "nope",
    },
    minter(),
  );
  assert.deepEqual(
    r[A]?.map((b) => [b.line, b.enabled]),
    [
      [2, true],
      [4, false],
    ],
  );
  assert.equal("/empty.py" in r, false);
  assert.equal("/bad.py" in r, false);
  assert.deepEqual(deserializeBreakpoints(null, minter()), {});
  assert.deepEqual(deserializeBreakpoints("junk", minter()), {});
});

/* ── the APP-011 gutter provider wiring ───────────────────────────────────────*/

test("gutterDecorationsFor maps enabled→filled, disabled→hollow, unverified→hover note", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 3, mint);
  s = toggleBreakpoint(s, A, 9, mint);
  s = setBreakpointEnabled(s, A, 9, false);
  s = applySetBreakpointsResponse(s, A, [3], [{ verified: false }]);
  const decs = gutterDecorationsFor(s[A] ?? []);
  assert.deepEqual(
    decs.map((d) => [d.line, d.glyphClassName, d.order]),
    [
      [3, "bp-glyph", BREAKPOINT_GLYPH_ORDER],
      [9, "bp-glyph-disabled", BREAKPOINT_GLYPH_ORDER],
    ],
  );
  assert.match(decs[0]?.hoverMessage ?? "", /unverified/);
  assert.match(decs[1]?.hoverMessage ?? "", /Disabled breakpoint/);
});

/** The identity uri seam node tests use in place of monaco.Uri. */
const TEST_URIS = {
  pathToModelUri: (path: string): string => `file://${path}`,
  modelUriToPath: (uri: string): string | null =>
    uri.startsWith("file://") ? uri.slice("file://".length) : null,
};

test("wireBreakpointGutter renders store changes into the REAL registry and sweeps emptied files", () => {
  useBreakpointStore.getState().restore({});
  const registry = createGutterRegistry();
  const unwire = wireBreakpointGutter(registry, TEST_URIS);
  try {
    useBreakpointStore.getState().toggle(A, 7);
    useBreakpointStore.getState().toggle(A, 2);
    let views = registry.decorationsForFile(`file://${A}`);
    assert.deepEqual(
      views.map((v) => [v.line, v.glyphClassName]),
      [
        [2, "bp-glyph"],
        [7, "bp-glyph"],
      ],
    );
    useBreakpointStore.getState().setEnabled(A, 7, false);
    views = registry.decorationsForFile(`file://${A}`);
    assert.equal(views.find((v) => v.line === 7)?.glyphClassName, "bp-glyph-disabled");
    // removing the file's last breakpoints sweeps its decorations entirely.
    useBreakpointStore.getState().clearFile(A);
    assert.deepEqual(registry.decorationsForFile(`file://${A}`), []);
  } finally {
    unwire();
    useBreakpointStore.getState().restore({});
  }
});

test("wireBreakpointGutter toggles on glyph-margin clicks — decorated AND undecorated lines", () => {
  useBreakpointStore.getState().restore({});
  const registry = createGutterRegistry();
  const unwire = wireBreakpointGutter(registry, TEST_URIS);
  try {
    // undecorated line → the "add one here" path.
    registry.emitClick({ path: `file://${A}`, line: 5 });
    assert.deepEqual(toDapSourceBreakpoints(useBreakpointStore.getState().byPath, A), [
      { line: 5 },
    ]);
    assert.equal(
      registry.decorationsForFile(`file://${A}`)[0]?.providerIds[0],
      BREAKPOINT_PROVIDER,
    );
    // decorated line → toggles it back off (glyph gone).
    registry.emitClick({ path: `file://${A}`, line: 5, providerId: BREAKPOINT_PROVIDER });
    assert.deepEqual(toDapSourceBreakpoints(useBreakpointStore.getState().byPath, A), []);
    assert.deepEqual(registry.decorationsForFile(`file://${A}`), []);
    // non-file schemes never toggle.
    registry.emitClick({ path: "scratch:untitled-1", line: 3 });
    assert.deepEqual(useBreakpointStore.getState().byPath, {});
    // a line ANOTHER provider won (e.g. the APP-014 test-run icon): the click is
    // theirs — running a test must not also toggle a breakpoint.
    registry.emitClick({ path: `file://${A}`, line: 9, providerId: "test-run" });
    assert.deepEqual(useBreakpointStore.getState().byPath, {});
  } finally {
    unwire();
    useBreakpointStore.getState().restore({});
  }
});

/* ── the zustand facade ───────────────────────────────────────────────────────*/

test("useBreakpointStore actions drive the reducers; same-ref no-ops don't notify", () => {
  useBreakpointStore.getState().restore({});
  let notified = 0;
  const unsub = useBreakpointStore.subscribe(() => {
    notified += 1;
  });
  try {
    useBreakpointStore.getState().toggle(A, 7);
    assert.deepEqual(toDapSourceBreakpoints(useBreakpointStore.getState().byPath, A), [
      { line: 7 },
    ]);
    assert.equal(notified, 1);
    useBreakpointStore.getState().setEnabled(A, 7, true); // already true — no notify
    assert.equal(notified, 1);
    useBreakpointStore.getState().setEnabled(A, 7, false);
    assert.equal(notified, 2);
    useBreakpointStore.getState().applyDapResponse(A, [], []); // nothing sent — no notify
    assert.equal(notified, 2);
    useBreakpointStore.getState().remove(A, 7);
    assert.equal(A in useBreakpointStore.getState().byPath, false);
    useBreakpointStore.getState().clearFile(A); // already gone — no notify
    assert.equal(notified, 3);
  } finally {
    unsub();
    useBreakpointStore.getState().restore({});
  }
});

/* ── APP-079: condition / hit-count / logpoint predicates ─────────────────────*/

test("updateBreakpoint sets condition/hitCondition/logMessage; blanks clear; only patched keys change", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 4, mint);
  s = updateBreakpoint(s, A, 4, { condition: "x > 3", hitCondition: ">5" }, mint);
  assert.deepEqual(
    [s[A]?.[0]?.condition, s[A]?.[0]?.hitCondition, s[A]?.[0]?.logMessage],
    ["x > 3", ">5", undefined],
  );
  // patching only logMessage leaves condition/hitCondition intact.
  s = updateBreakpoint(s, A, 4, { logMessage: "here {x}" }, mint);
  assert.equal(s[A]?.[0]?.condition, "x > 3");
  assert.equal(s[A]?.[0]?.logMessage, "here {x}");
  // a blank value CLEARS that key (never sent as an empty predicate).
  s = updateBreakpoint(s, A, 4, { condition: "   " }, mint);
  assert.equal(s[A]?.[0]?.condition, undefined);
  assert.equal(s[A]?.[0]?.hitCondition, ">5");
});

test("updateBreakpoint creates a breakpoint when absent (right-click 'add logpoint'), no-ops on empty create", () => {
  const mint = minter();
  const s0 = initialBreakpointsState();
  // no breakpoint at A:8 yet — setting a logMessage seeds an enabled one.
  const s1 = updateBreakpoint(s0, A, 8, { logMessage: "reached {n}" }, mint);
  assert.equal(s1[A]?.[0]?.line, 8);
  assert.equal(s1[A]?.[0]?.enabled, true);
  assert.equal(s1[A]?.[0]?.logMessage, "reached {n}");
  // seeding with only blanks creates nothing (same-ref).
  assert.equal(updateBreakpoint(s0, A, 9, { condition: "" }, mint), s0);
  // an unchanged patch on an existing breakpoint is a same-ref no-op.
  assert.equal(updateBreakpoint(s1, A, 8, { logMessage: "reached {n}" }, mint), s1);
});

test("toDapSourceBreakpoints passes condition/hitCondition/logMessage through, omitting empties", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 3, mint);
  s = toggleBreakpoint(s, A, 7, mint);
  s = updateBreakpoint(s, A, 3, { condition: "i == 2", hitCondition: "%3" }, mint);
  s = updateBreakpoint(s, A, 7, { logMessage: "n={n}" }, mint);
  assert.deepEqual(toDapSourceBreakpoints(s, A), [
    { line: 3, condition: "i == 2", hitCondition: "%3" },
    { line: 7, logMessage: "n={n}" },
  ]);
});

test("dapAffectedPaths surfaces a predicate-only edit (must re-send setBreakpoints)", () => {
  const mint = minter();
  const s1 = toggleBreakpoint(initialBreakpointsState(), A, 5, mint);
  const s2 = updateBreakpoint(s1, A, 5, { condition: "x > 3" }, mint);
  assert.deepEqual(dapAffectedPaths(s1, s2), [A]);
  // changing the condition text again still surfaces it.
  const s3 = updateBreakpoint(s2, A, 5, { condition: "x > 4" }, mint);
  assert.deepEqual(dapAffectedPaths(s2, s3), [A]);
});

test("dapLaunchPlan lists every source with enabled breakpoints as SourceBreakpoint[]", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), B, 2, mint);
  s = toggleBreakpoint(s, A, 4, mint);
  s = updateBreakpoint(s, A, 4, { condition: "ok" }, mint);
  s = toggleBreakpoint(s, "/ws/c.py", 1, mint);
  s = setBreakpointEnabled(s, "/ws/c.py", 1, false); // all-disabled → excluded
  assert.deepEqual(dapLaunchPlan(s), [
    { path: A, breakpoints: [{ line: 4, condition: "ok" }] },
    { path: B, breakpoints: [{ line: 2 }] },
  ]);
});

test("isLogpoint / isConditional / breakpointDetail classify the predicates", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 1, mint);
  s = updateBreakpoint(s, A, 1, { condition: "x", hitCondition: ">2" }, mint);
  s = toggleBreakpoint(s, A, 2, mint);
  s = updateBreakpoint(s, A, 2, { logMessage: "hi {x}" }, mint);
  const [cond, log] = [s[A]![0]!, s[A]![1]!];
  assert.equal(isConditional(cond), true);
  assert.equal(isLogpoint(cond), false);
  assert.equal(isLogpoint(log), true);
  assert.equal(breakpointGlyphClass(cond), "bp-glyph-conditional");
  assert.equal(breakpointGlyphClass(log), "bp-logpoint");
  assert.match(breakpointDetail(cond), /when x · hits >2/);
  assert.match(breakpointDetail(log), /log: hi \{x\}/);
});

test("gutterDecorationsFor renders distinct logpoint/conditional glyphs + disabled variants", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 1, mint);
  s = updateBreakpoint(s, A, 1, { condition: "x>0" }, mint);
  s = toggleBreakpoint(s, A, 2, mint);
  s = updateBreakpoint(s, A, 2, { logMessage: "L" }, mint);
  s = setBreakpointEnabled(s, A, 2, false);
  const decs = gutterDecorationsFor(s[A] ?? []);
  assert.deepEqual(
    decs.map((d) => [d.line, d.glyphClassName]),
    [
      [1, "bp-glyph-conditional"],
      [2, "bp-logpoint-disabled"],
    ],
  );
  assert.match(decs[0]?.hoverMessage ?? "", /Conditional breakpoint/);
  assert.match(decs[1]?.hoverMessage ?? "", /Disabled logpoint/);
});

test("serialize→deserialize round-trips predicates (condition/hitCondition/logMessage)", () => {
  const mint = minter();
  let s = toggleBreakpoint(initialBreakpointsState(), A, 3, mint);
  s = updateBreakpoint(
    s,
    A,
    3,
    { condition: "a == b", hitCondition: ">5", logMessage: "x={x}" },
    mint,
  );
  const blob = JSON.parse(JSON.stringify(serializeBreakpoints(s))) as unknown;
  const r = deserializeBreakpoints(blob, minter());
  assert.deepEqual(
    [r[A]?.[0]?.condition, r[A]?.[0]?.hitCondition, r[A]?.[0]?.logMessage],
    ["a == b", ">5", "x={x}"],
  );
});

test("useBreakpointStore.update drives the predicate reducer through the facade", () => {
  useBreakpointStore.getState().restore({});
  try {
    useBreakpointStore.getState().toggle(A, 6);
    useBreakpointStore.getState().update(A, 6, { condition: "y != 0" });
    assert.equal(useBreakpointStore.getState().byPath[A]?.[0]?.condition, "y != 0");
  } finally {
    useBreakpointStore.getState().restore({});
  }
});
