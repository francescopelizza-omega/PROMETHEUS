/**
 * agent-loop.test.ts — node:test for the agentic tool-loop orchestration (#2).
 *
 * The model is replaced by a scripted `runTurn` so the loop logic is pinned with no
 * network: read-only tools auto-run + feed results back into the next turn's messages;
 * run_command PAUSES the loop (nothing auto-executes). Pure/injected — runs under node.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyReviewFile } from "../state/diff-review-state.js";
import {
  type CommandResult,
  type ProposedEdit,
  buildReviewFile,
  createProposeEditTool,
  normalizeWorkspaceRelPath,
  parseApplyPatchArgs,
  parseProposeEditArgs,
} from "./agent-loop.js";

const EP: RendererEndpoint = { id: "x", baseUrl: "http://localhost:1", locality: "local" };

function baseDeps(runTurn: AgentLoopRunTurn, over: Partial<DepOver> = {}) {
  const notes: string[] = [];
  let committed = 0;
  let proposed = "";
  const proposedEdits: ProposedEdit[] = [];
  const deps = {
    endpoint: EP,
    neverSendToCloud: false,
    signal: new AbortController().signal,
    tools: {
      readFile: over.readFile ?? (async (p: string) => `CONTENT ${p}`),
      listDir: over.listDir ?? (async () => "a.ts\nb.ts"),
      grep: async () => "src/x.ts:12",
      proposeEdit:
        over.proposeEdit ??
        (async (e: ProposedEdit) => {
          proposedEdits.push(e);
          return `✓ proposed 1 edit to ${e.path}`;
        }),
      proposeCommand: (c: string) => {
        proposed = c;
        return `proposed: ${c}`;
      },
    },
    onText: () => {},
    onTurnComplete: () => {
      committed++;
    },
    onToolNote: (n: string) => {
      notes.push(n);
    },
    runTurn,
  };
  return {
    deps,
    notes: () => notes,
    committed: () => committed,
    proposed: () => proposed,
    proposedEdits: () => proposedEdits,
  };
}

type AgentLoopRunTurn = (
  ep: RendererEndpoint,
  messages: { role: string; content: string }[],
  opts: unknown,
) => Promise<ChatTurnResult>;
interface DepOver {
  readFile: (p: string) => Promise<string>;
  listDir: (p: string) => Promise<string>;
  proposeEdit: (e: ProposedEdit) => Promise<string>;
}

/*
 * The loop tests that used to sit here (auto-run read_file, pause on run_command,
 * pause→resume, denial resume, iter-budget, abort-while-paused) went with the loop they
 * covered — see core-agent.test.ts, which tests the invariants that REPLACED them: the
 * broker routing, the --force ban, and the confirm-default-deny that the fork never had.
 */

test("normalizeWorkspaceRelPath rejects absolute / escaping / bogus paths", () => {
  assert.equal(normalizeWorkspaceRelPath("/etc/passwd"), null);
  assert.equal(normalizeWorkspaceRelPath("C:\\win\\x.ts"), null);
  assert.equal(normalizeWorkspaceRelPath("file:///x.ts"), null);
  assert.equal(normalizeWorkspaceRelPath("~/x.ts"), null);
  assert.equal(normalizeWorkspaceRelPath("../up.ts"), null);
  assert.equal(normalizeWorkspaceRelPath("a/../../up.ts"), null); // dots resolve FIRST
  assert.equal(normalizeWorkspaceRelPath(""), null);
  assert.equal(normalizeWorkspaceRelPath("."), null);
});

test("normalizeWorkspaceRelPath normalizes in-workspace paths", () => {
  assert.equal(normalizeWorkspaceRelPath("src/a.ts"), "src/a.ts");
  assert.equal(normalizeWorkspaceRelPath("./src//a.ts"), "src/a.ts");
  assert.equal(normalizeWorkspaceRelPath("src/sub/../a.ts"), "src/a.ts");
});

/* ── propose_edit: arg validation ─────────────────────────────────────────── */

test("parseProposeEditArgs validates path + edits and normalizes", () => {
  const good = parseProposeEditArgs({
    path: "./src/a.ts",
    edits: [{ oldText: "x", newText: "y" }],
    description: " tidy ",
  });
  assert.ok(good.ok);
  assert.deepEqual(good.edit, {
    path: "src/a.ts",
    spans: [{ oldText: "x", newText: "y" }],
    description: "tidy",
  });
  assert.equal(parseProposeEditArgs({ edits: [{ oldText: "x", newText: "y" }] }).ok, false);
  assert.equal(
    parseProposeEditArgs({ path: "/abs.ts", edits: [{ oldText: "x", newText: "y" }] }).ok,
    false,
  );
  assert.equal(parseProposeEditArgs({ path: "a.ts", edits: [] }).ok, false);
  assert.equal(parseProposeEditArgs({ path: "a.ts", edits: [{ oldText: 1 }] }).ok, false);
  assert.equal(parseProposeEditArgs({ path: "a.ts" }).ok, false);
});

/* ── propose_edit: hunk math ──────────────────────────────────────────────── */

test("buildReviewFile hunks a multi-line exact span (whole-line expansion)", () => {
  const r = buildReviewFile(
    "file:///w/a.ts",
    "a\nb\nc\nd",
    [{ oldText: "b\nc", newText: "B" }],
    "t",
  );
  assert.ok(r.ok);
  assert.deepEqual(r.file.hunks, [
    { id: "t-0", originalStart: 1, originalLines: 2, oldLines: ["b", "c"], newLines: ["B"] },
  ]);
});

test("buildReviewFile expands a partial-line span to the whole line", () => {
  const original = "const x = 1;\nconst y = 2;";
  const r = buildReviewFile("u", original, [{ oldText: "x = 1", newText: "x = 42" }], "t");
  assert.ok(r.ok);
  assert.deepEqual(r.file.hunks, [
    {
      id: "t-0",
      originalStart: 0,
      originalLines: 1,
      oldLines: ["const x = 1;"],
      newLines: ["const x = 42;"],
    },
  ]);
});

test("buildReviewFile: whole-line deletion produces an empty splice", () => {
  const r = buildReviewFile("u", "a\nb\nc", [{ oldText: "b", newText: "" }], "t");
  assert.ok(r.ok);
  assert.deepEqual(r.file.hunks[0]?.newLines, []);
  assert.equal(applyReviewFile("a\nb\nc", r.file, ["t-0"]), "a\nc");
});

test("buildReviewFile rejects not-found / non-unique / empty oldText on existing files", () => {
  assert.match(
    (buildReviewFile("u", "a\nb", [{ oldText: "zzz", newText: "y" }], "t") as { error: string })
      .error,
    /not found/,
  );
  assert.match(
    (buildReviewFile("u", "a\na", [{ oldText: "a", newText: "y" }], "t") as { error: string })
      .error,
    /more than once/,
  );
  assert.match(
    (buildReviewFile("u", "a\nb", [{ oldText: "", newText: "y" }], "t") as { error: string }).error,
    /non-empty/,
  );
});

test("buildReviewFile rejects overlapping spans on the same lines", () => {
  const r = buildReviewFile(
    "u",
    "one two three",
    [
      { oldText: "one", newText: "1" },
      { oldText: "three", newText: "3" },
    ],
    "t",
  );
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /overlap/);
});

test("buildReviewFile creates a NEW file only from a single ''-oldText span", () => {
  const ok = buildReviewFile("u", null, [{ oldText: "", newText: "hi\nthere" }], "t");
  assert.ok(ok.ok);
  assert.equal(ok.file.isNew, true);
  assert.deepEqual(ok.file.hunks, [
    { id: "t-0", originalStart: 0, originalLines: 0, oldLines: [], newLines: ["hi", "there"] },
  ]);
  const bad = buildReviewFile("u", null, [{ oldText: "x", newText: "y" }], "t");
  assert.equal(bad.ok, false);
});

test("buildReviewFile: a no-op span (oldText === newText) yields ZERO hunks", () => {
  const r = buildReviewFile("u", "a\nb\nc", [{ oldText: "b", newText: "b" }], "t");
  assert.ok(r.ok);
  assert.deepEqual(r.file.hunks, []); // the pane shows "no changes", never a phantom hunk
});

test("buildReviewFile: an EMPTY new file keeps one all-add hunk (still creatable)", () => {
  const r = buildReviewFile("u", null, [{ oldText: "", newText: "" }], "t");
  assert.ok(r.ok);
  assert.equal(r.file.isNew, true);
  assert.deepEqual(r.file.hunks, [
    { id: "t-0", originalStart: 0, originalLines: 0, oldLines: [], newLines: [""] },
  ]);
  assert.equal(applyReviewFile("", r.file, ["t-0"]), "");
});

test("buildReviewFile hunks roundtrip through applyReviewFile", () => {
  const original = "line1\nline2\nline3\nline4";
  const r = buildReviewFile(
    "u",
    original,
    [
      { oldText: "line1", newText: "L1a\nL1b" },
      { oldText: "line3", newText: "L3" },
    ],
    "t",
  );
  assert.ok(r.ok);
  const all = r.file.hunks.map((h) => h.id);
  assert.equal(applyReviewFile(original, r.file, all), "L1a\nL1b\nline2\nL3\nline4");
});

/* ── propose_edit: loop orchestration ─────────────────────────────────────── */

/*
 * `createProposeEditTool accumulates the turn's edits into ONE ChangeSet` lived here and
 * drove the retired loop to get two propose_edit calls into one turn. The accumulation it
 * covered is exercised directly by the next test (two tool() calls, one dispatch) — the
 * loop was only ever the delivery mechanism.
 */

test("createProposeEditTool drops stale entries after the user Applied/Discarded mid-run", async () => {
  const dispatched: { edits: { uri: string }[] }[] = [];
  let liveId: string | null = null; // what the session's store currently holds
  const files: Record<string, string> = { "file:///w/a.ts": "aaa\nbbb", "file:///w/b.ts": "ccc" };
  const tool = createProposeEditTool({
    changeSetId: "cs-1",
    toUri: (rel) => `file:///w/${rel}`,
    readOriginal: async (uri) => files[uri] ?? null,
    dispatch: (cs) => {
      dispatched.push(cs);
      liveId = cs.id;
    },
    currentChangeSetId: () => liveId,
  });
  await tool({ path: "a.ts", spans: [{ oldText: "aaa", newText: "AAA" }] });
  // the user clicks Apply (or Discard) — the store's changeset is cleared.
  liveId = null;
  await tool({ path: "b.ts", spans: [{ oldText: "ccc", newText: "CCC" }] });
  // a.ts's already-consumed hunks are NOT resurrected in the fresh dispatch.
  assert.deepEqual(
    dispatched[1]?.edits.map((e) => e.uri),
    ["file:///w/b.ts"],
  );
});

/* ── apply_patch: a multi-file edit, into the SAME review queue ────────────*/

/**
 * The pane could not express a multi-file change: a rename-and-update-its-callers had to be N
 * separate `propose_edit` calls, each reviewed on its own, so the user approved half a refactor
 * and then the other half.
 *
 * The CLI's two-phase resolve-then-write is deliberately NOT copied here — it exists because the
 * CLI writes disk directly, whereas the user's single Apply in DiffReview already is the atomic
 * step. Copying it would add a second write path to keep correct.
 */

test("a multi-file patch becomes one proposed edit per file", () => {
  const r = parseApplyPatchArgs({
    edits: [
      { path: "src/a.ts", hunks: [{ old: "one", new: "1" }] },
      { path: "src/b.ts", hunks: [{ old: "two", new: "2" }] },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(
      r.edits.map((e) => e.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.deepEqual(r.edits[0]?.spans, [{ oldText: "one", newText: "1" }]);
  }
});

test("the field names are core's `{old,new}`, not the renderer's `{oldText,newText}`", () => {
  // The two spellings mean the same thing, and accepting both would invite a model to guess.
  const r = parseApplyPatchArgs({
    edits: [{ path: "a.ts", hunks: [{ oldText: "x", newText: "y" }] }],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /string `old` and a string `new`/);
});

test("a JSON STRING of edits is parsed — models send one constantly", () => {
  const r = parseApplyPatchArgs({
    edits: JSON.stringify([{ path: "a.ts", hunks: [{ old: "x", new: "y" }] }]),
  });
  assert.equal(r.ok, true);
});

test("a path that escapes the workspace is refused, per file", () => {
  for (const p of ["../../etc/passwd", "/etc/passwd", "~/x"]) {
    const r = parseApplyPatchArgs({ edits: [{ path: p, hunks: [{ old: "a", new: "b" }] }] });
    assert.equal(r.ok, false, `${p} was accepted`);
  }
});

test("an entry with no hunks names the file it belongs to", () => {
  const r = parseApplyPatchArgs({ edits: [{ path: "a.ts", hunks: [] }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /a\.ts/);
});

test("garbage yields an actionable error, never a silent empty patch", () => {
  for (const bad of [undefined, [], "not json", 42, {}]) {
    const r = parseApplyPatchArgs({ edits: bad });
    assert.equal(r.ok, false, `accepted ${String(bad)}`);
    if (!r.ok) assert.match(r.error, /path, hunks/);
  }
});
