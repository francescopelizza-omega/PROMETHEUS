/**
 * test-run-store.test.ts — node:test for the Test Explorer run model (APP-014).
 *
 * Pins the discover-tree projections (case expansion, run-all target ids, the
 * documented framework discriminator, node→file/line lookup), the event fold
 * (duplicate-event idempotence, parent re-aggregation through applyStates, the
 * settle-to-pending rule for cases that never reported), the run orchestration
 * (re-entry NO-OP — never a parallel run; subscription-lifetime event keying —
 * a late event can't repaint; rerun-failed sends ONLY the failed ids; a failed
 * run restores the pre-run maps), and the APP-011 gutter wiring against the
 * REAL registry (glyphs on case lines, click runs exactly one id, another
 * provider's winning click is ignored). Pure — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { IdeTestEvent, IdeTestRunResult } from "../../../shared/ipc-contract.js";
import { createGutterRegistry } from "../state/gutter-decorations.js";
import {
  TEST_RUN_GLYPH_ORDER,
  TEST_RUN_PROVIDER,
  type TestRunIde,
  absTestPath,
  caseIdsUnder,
  casesByFile,
  createTestRunStore,
  foldEvent,
  frameworkForId,
  glyphClassFor,
  markRunning,
  relTestPath,
  runTargetIds,
  runTests,
  settleCrashed,
  settleRun,
  testGutterDecorations,
  wireTestRunGutter,
} from "./test-run-store.js";
import { type TestNodeView, applyStates } from "./test-view.js";

const A1 = "tests/test_a.py::test_one";
const A2 = "tests/test_a.py::TestC::test_two";
const B1 = "tests/test_b.py::test_three";

const TREE: TestNodeView[] = [
  {
    id: "tests/test_a.py",
    kind: "file",
    label: "test_a.py",
    file: "tests/test_a.py",
    children: [
      { id: A1, kind: "case", label: "test_one", file: "tests/test_a.py", line: 3 },
      {
        id: "tests/test_a.py::TestC",
        kind: "class",
        label: "TestC",
        file: "tests/test_a.py",
        line: 6,
        children: [{ id: A2, kind: "case", label: "test_two", file: "tests/test_a.py", line: 7 }],
      },
    ],
  },
  {
    id: "tests/test_b.py",
    kind: "file",
    label: "test_b.py",
    file: "tests/test_b.py",
    children: [{ id: B1, kind: "case", label: "test_three", file: "tests/test_b.py", line: 1 }],
  },
];

const ROOT = "/ws/proj";

/* ── discover-tree projections ────────────────────────────────────────────────*/

test("caseIdsUnder expands file/class ids to leaf cases; a case id is itself", () => {
  assert.deepEqual(caseIdsUnder(TREE, ["tests/test_a.py"]), [A1, A2]);
  assert.deepEqual(caseIdsUnder(TREE, ["tests/test_a.py::TestC"]), [A2]);
  assert.deepEqual(caseIdsUnder(TREE, [B1]), [B1]);
  assert.deepEqual(caseIdsUnder(TREE, ["nope"]), []);
});

test("runTargetIds: a selection passes through; run-all ([]) sends the root ids (never empty)", () => {
  assert.deepEqual(runTargetIds(TREE, [A2]), [A2]);
  assert.deepEqual(runTargetIds(TREE, []), ["tests/test_a.py", "tests/test_b.py"]);
});

test("frameworkForId: pytest-shaped discover ids vs dotted unittest ids — never a guess", () => {
  assert.equal(frameworkForId(A2), "pytest");
  assert.equal(frameworkForId("tests/test_a.py"), "pytest");
  assert.equal(frameworkForId("pkg.mod.TestC.test_two"), "unittest");
});

test("casesByFile maps located cases per discover file; abs/rel path helpers round-trip", () => {
  const byFile = casesByFile(TREE);
  assert.deepEqual(
    byFile.get("tests/test_a.py")?.map((c) => [c.id, c.line]),
    [
      [A1, 3],
      [A2, 7],
    ],
  );
  const abs = absTestPath(ROOT, "tests/test_a.py");
  assert.equal(abs, "/ws/proj/tests/test_a.py");
  assert.equal(relTestPath(ROOT, abs), "tests/test_a.py");
  assert.equal(relTestPath(ROOT, "/elsewhere/x.py"), null);
  assert.equal(absTestPath(ROOT, "/already/abs.py"), "/already/abs.py");
});

/* ── event fold + aggregation ─────────────────────────────────────────────────*/

test("foldEvent SETS state (duplicate events are idempotent) and carries the message", () => {
  let maps = markRunning({ states: {}, messages: {}, output: {}, sites: {} }, [A1, A2]);
  assert.equal(maps.states[A1], "running");
  const fail: IdeTestEvent = { id: A1, status: "fail", message: "assert 1 == 2" };
  maps = foldEvent(maps, fail);
  const again = foldEvent(maps, fail);
  assert.deepEqual(again.states, maps.states);
  assert.equal(again.messages[A1], "assert 1 == 2");
  // a later pass clears the stale failure message.
  const fixed = foldEvent(again, { id: A1, status: "pass" });
  assert.equal(fixed.states[A1], "pass");
  assert.equal(fixed.messages[A1], undefined);
});

test("parents re-fold from child states: any fail→fail, running while live, all-pass→pass", () => {
  let maps = markRunning({ states: {}, messages: {}, output: {}, sites: {} }, [A1, A2]);
  const applied = (): TestNodeView =>
    applyStates(
      TREE[0] as TestNodeView,
      new Map(Object.entries(maps.states)),
      new Map(Object.entries(maps.messages)),
    );
  assert.equal(applied().state, "running");
  maps = foldEvent(maps, { id: A1, status: "pass" });
  assert.equal(applied().state, "running"); // A2 still live
  maps = foldEvent(maps, { id: A2, status: "fail", message: "boom" });
  const tree = applied();
  assert.equal(tree.state, "fail");
  assert.equal(tree.children?.[1]?.children?.[0]?.message, "boom");
  maps = foldEvent(maps, { id: A2, status: "pass" });
  assert.equal(applied().state, "pass");
});

test("settleRun returns never-reported running cases to pending (no fake verdicts)", () => {
  assert.deepEqual(settleRun({ [A1]: "pass", [A2]: "running" }), {
    [A1]: "pass",
    [A2]: "pending",
  });
});

test("settleCrashed synthesizes fail for still-running cases (a crashed run, APP-040)", () => {
  assert.deepEqual(settleCrashed({ [A1]: "pass", [A2]: "running" }), {
    [A1]: "pass",
    [A2]: "fail",
  });
});

test("foldEvent merges the follow-up failure output + file:line and never wipes them (APP-040)", () => {
  let maps = markRunning({ states: {}, messages: {}, output: {}, sites: {} }, [A1]);
  maps = foldEvent(maps, { id: A1, status: "fail" }); // live status, no output yet
  assert.equal(maps.output[A1], undefined);
  maps = foldEvent(maps, {
    id: A1,
    status: "fail",
    output: ["E   AssertionError"],
    file: "t.py",
    line: 9,
  });
  assert.deepEqual(maps.output[A1], ["E   AssertionError"]);
  assert.deepEqual(maps.sites[A1], { file: "t.py", line: 9 });
  const after = foldEvent(maps, { id: A1, status: "fail" }); // a later status-only event
  assert.deepEqual(after.output[A1], ["E   AssertionError"]);
  assert.deepEqual(after.sites[A1], { file: "t.py", line: 9 });
});

/* ── gutter decoration projection ─────────────────────────────────────────────*/

test("testGutterDecorations: status-classed glyphs, hover carries label+message, shared line deduped", () => {
  const cases = [
    { id: A1, line: 3, label: "test_one" },
    { id: A2, line: 3, label: "test_two" }, // same line — Monaco renders ONE glyph
  ];
  const decs = testGutterDecorations(cases, {
    states: { [A1]: "fail" },
    messages: { [A1]: "assert 1 == 2" },
  });
  assert.equal(decs.length, 1);
  assert.equal(decs[0]?.glyphClassName, "test-run-glyph-fail");
  assert.equal(decs[0]?.order, TEST_RUN_GLYPH_ORDER);
  assert.match(decs[0]?.hoverMessage ?? "", /test_one — fail/);
  assert.match(decs[0]?.hoverMessage ?? "", /assert 1 == 2/);
  assert.equal(glyphClassFor(undefined), "test-run-glyph");
  assert.equal(glyphClassFor("pass"), "test-run-glyph-pass");
  assert.equal(glyphClassFor("error"), "test-run-glyph-fail");
  assert.equal(glyphClassFor("running"), "test-run-glyph-running");
  assert.equal(glyphClassFor("skip"), "test-run-glyph-skip");
});

/* ── run orchestration ────────────────────────────────────────────────────────*/

interface FakeIde extends TestRunIde {
  emit(ev: IdeTestEvent): void;
  resolveRun(result: IdeTestRunResult): void;
  runCalls: { root: string; framework: string; ids: string[] }[];
  rerunCalls: { root: string; framework: string; ids: string[] }[];
  listeners: number;
}

/** A hand-resolved APP-013 seam: events emit only to LIVE subscriptions. */
function fakeIde(): FakeIde {
  const live = new Set<(ev: IdeTestEvent) => void>();
  let resolver: ((r: IdeTestRunResult) => void) | null = null;
  const pending = (): Promise<IdeTestRunResult> =>
    new Promise((res) => {
      resolver = res;
    });
  const ide: FakeIde = {
    runCalls: [],
    rerunCalls: [],
    get listeners() {
      return live.size;
    },
    testRun: (root, framework, ids) => {
      ide.runCalls.push({ root, framework, ids });
      return pending();
    },
    testRerunFailed: (root, framework, ids) => {
      ide.rerunCalls.push({ root, framework, ids });
      return pending();
    },
    onTestEvent: (listener) => {
      live.add(listener);
      return () => live.delete(listener);
    },
    emit: (ev) => {
      for (const fn of [...live]) fn(ev);
    },
    resolveRun: (result) => {
      resolver?.(result);
      resolver = null;
    },
  };
  return ide;
}

function discoveredStore(): ReturnType<typeof createTestRunStore> {
  const store = createTestRunStore();
  store.getState().setDiscovered(ROOT, TREE);
  return store;
}

test("runTests: begin marks cases running, events fold live, ok settles stragglers", async () => {
  const store = discoveredStore();
  const ide = fakeIde();
  const done = runTests([], {}, store, ide);
  assert.equal(store.getState().running, true);
  assert.deepEqual(ide.runCalls, [
    { root: ROOT, framework: "pytest", ids: ["tests/test_a.py", "tests/test_b.py"] },
  ]);
  assert.equal(store.getState().states[A1], "running");
  ide.emit({ id: A1, status: "pass" });
  ide.emit({ id: A2, status: "fail", message: "boom" });
  assert.equal(store.getState().states[A2], "fail");
  ide.resolveRun({ ok: true, summary: { total: 3, passed: 1, failed: 1, skipped: 0 } });
  const result = await done;
  assert.equal(result?.ok, true);
  const s = store.getState();
  assert.equal(s.running, false);
  assert.equal(s.states[B1], "pending"); // never reported — settled, not faked
  assert.equal(s.messages[A2], "boom");
  // subscription-lifetime keying: the run's listener is gone — a stale child's
  // late event can never repaint the tree.
  assert.equal(ide.listeners, 0);
  ide.emit({ id: A1, status: "fail" });
  assert.equal(store.getState().states[A1], "pass");
});

test("runTests re-entry while running is a NO-OP — never a parallel run", async () => {
  const store = discoveredStore();
  const ide = fakeIde();
  const first = runTests([A1], {}, store, ide);
  assert.equal(await runTests([A2], {}, store, ide), null);
  assert.equal(ide.runCalls.length, 1);
  ide.resolveRun({ ok: true });
  await first;
});

test("runTests rerun sends ONLY the given failed ids over the rerun-failed seam", async () => {
  const store = discoveredStore();
  const ide = fakeIde();
  const done = runTests([A2, B1], { rerun: true }, store, ide);
  assert.deepEqual(ide.rerunCalls, [{ root: ROOT, framework: "pytest", ids: [A2, B1] }]);
  assert.equal(ide.runCalls.length, 0);
  ide.resolveRun({ ok: true });
  await done;
});

test("a failed run restores the pre-run maps and surfaces the run-level error", async () => {
  const store = discoveredStore();
  const ide = fakeIde();
  // seed a previous verdict that must survive the failed run (feeds rerun-failed).
  store.getState().begin([A1]);
  store.getState().applyEvent({ id: A1, status: "fail", message: "old" });
  store.getState().finishOk();
  const done = runTests([], {}, store, ide);
  assert.equal(store.getState().states[A1], "running");
  ide.resolveRun({ ok: false, error: "pytest is not installed" });
  await done;
  const s = store.getState();
  assert.equal(s.running, false);
  assert.equal(s.lastError, "pytest is not installed");
  assert.equal(s.states[A1], "fail");
  assert.equal(s.messages[A1], "old");
});

test("runTests crash mid-stream keeps streamed states; still-running → fail (APP-040)", async () => {
  const store = discoveredStore();
  const ide = fakeIde();
  const done = runTests([], {}, store, ide);
  ide.emit({ id: A1, status: "pass" }); // one test completed…
  ide.resolveRun({ ok: false, error: "process exited 137 (SIGKILL)" }); // …then it crashed
  await done;
  const s = store.getState();
  assert.equal(s.running, false);
  assert.equal(s.lastError, "process exited 137 (SIGKILL)");
  assert.equal(s.states[A1], "pass"); // the streamed result is KEPT (not restored away)
  assert.equal(s.states[A2], "fail"); // a still-running straggler is synthesized to fail
});

test("runTests without a discovered root (or with nothing to run) is a NO-OP", async () => {
  const empty = createTestRunStore();
  const ide = fakeIde();
  assert.equal(await runTests([], {}, empty, ide), null);
  empty.getState().setDiscovered(ROOT, []);
  assert.equal(await runTests([], {}, empty, ide), null);
  assert.equal(ide.runCalls.length, 0);
});

/* ── the APP-011 gutter wiring (REAL registry) ────────────────────────────────*/

/** The identity uri seam node tests use in place of monaco.Uri. */
const TEST_URIS = {
  pathToModelUri: (path: string): string => `file://${path}`,
  modelUriToPath: (uri: string): string | null =>
    uri.startsWith("file://") ? uri.slice("file://".length) : null,
};

test("wireTestRunGutter places glyphs on case lines and live-updates them from run state", () => {
  const store = discoveredStore();
  const registry = createGutterRegistry();
  const unwire = wireTestRunGutter(registry, TEST_URIS, store, () => {});
  try {
    const uriA = `file://${ROOT}/tests/test_a.py`;
    assert.deepEqual(
      registry.decorationsForFile(uriA).map((v) => [v.line, v.glyphClassName]),
      [
        [3, "test-run-glyph"],
        [7, "test-run-glyph"],
      ],
    );
    store.getState().begin([A1]);
    store.getState().applyEvent({ id: A1, status: "fail", message: "boom" });
    store.getState().finishOk();
    const views = registry.decorationsForFile(uriA);
    assert.equal(views.find((v) => v.line === 3)?.glyphClassName, "test-run-glyph-fail");
    assert.match(views.find((v) => v.line === 3)?.hoverMessages[0] ?? "", /boom/);
    // a re-discover that drops a file sweeps its decorations.
    store.getState().setDiscovered(ROOT, [TREE[1] as TestNodeView]);
    assert.deepEqual(registry.decorationsForFile(uriA), []);
    assert.equal(
      registry.decorationsForFile(`file://${ROOT}/tests/test_b.py`)[0]?.providerIds[0],
      TEST_RUN_PROVIDER,
    );
  } finally {
    unwire();
  }
});

test("wireTestRunGutter click runs EXACTLY the clicked case; other providers' clicks are ignored", () => {
  const store = discoveredStore();
  const registry = createGutterRegistry();
  const ran: string[][] = [];
  const unwire = wireTestRunGutter(registry, TEST_URIS, store, (ids) => ran.push(ids));
  try {
    const uriA = `file://${ROOT}/tests/test_a.py`;
    registry.emitClick({ path: uriA, line: 7, providerId: TEST_RUN_PROVIDER });
    assert.deepEqual(ran, [[A2]]);
    // a line another provider won (e.g. a breakpoint) is that provider's click.
    registry.emitClick({ path: uriA, line: 3, providerId: "breakpoints" });
    // an undecorated line carries no providerId — not a run either.
    registry.emitClick({ path: uriA, line: 4 });
    // a non-file scheme and a path outside the discover root never run.
    registry.emitClick({ path: "scratch:untitled-1", line: 7, providerId: TEST_RUN_PROVIDER });
    registry.emitClick({ path: "file:///elsewhere/x.py", line: 7, providerId: TEST_RUN_PROVIDER });
    assert.deepEqual(ran, [[A2]]);
  } finally {
    unwire();
  }
});
