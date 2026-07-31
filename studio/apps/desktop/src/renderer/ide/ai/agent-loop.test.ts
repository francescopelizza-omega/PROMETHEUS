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
  AGENT_TOOLS,
  type CommandResult,
  type ProposedEdit,
  buildReviewFile,
  createProposeEditTool,
  formatCommandResult,
  normalizeWorkspaceRelPath,
  parseProposeEditArgs,
  parseToolArgs,
  resumeAgentLoop,
  runAgentLoop,
  truncateMiddle,
} from "./agent-loop.js";
import type { ChatTurnResult, RendererEndpoint } from "./ai-client.js";

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

test("auto-runs read_file, feeds the result back, then completes on a text answer", async () => {
  const seen: string[][] = [];
  const turns: ChatTurnResult[] = [
    {
      text: "",
      toolCalls: [{ id: "1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) }],
    },
    { text: "done.", toolCalls: [] },
  ];
  let i = 0;
  const runTurn: AgentLoopRunTurn = async (_ep, messages) => {
    seen.push(messages.map((m) => m.content));
    return turns[i++] as ChatTurnResult;
  };
  const h = baseDeps(runTurn);
  await runAgentLoop(
    [
      { role: "system", content: "sys" },
      { role: "user", content: "read a.ts" },
    ],
    h.deps as never,
  );
  // the SECOND turn must have received the fed-back file content as context.
  assert.ok(
    seen[1]?.some((c) => c.includes("CONTENT a.ts")),
    "read result fed back",
  );
  assert.ok(h.notes().some((n) => n.includes("read a.ts")));
  assert.equal(h.committed(), 1); // only the final text turn commits
});

test("pauses on run_command — never auto-executes, never calls the model again", async () => {
  const turns: ChatTurnResult[] = [
    {
      text: "",
      toolCalls: [
        { id: "1", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) },
      ],
    },
    { text: "unreached", toolCalls: [] },
  ];
  let i = 0;
  const runTurn: AgentLoopRunTurn = async () => turns[i++] as ChatTurnResult;
  const h = baseDeps(runTurn);
  await runAgentLoop([{ role: "user", content: "run tests" }], h.deps as never);
  assert.equal(h.proposed(), "npm test");
  assert.equal(i, 1); // loop stopped after the first turn (paused for approval)
});

// ---- pause → resume (APP-050) ---------------------------------------------- //

/** A scripted runTurn over a fixed list; records the messages each turn received. */
function scripted(turns: ChatTurnResult[], seen: string[][], signal?: AbortSignal) {
  let i = 0;
  const runTurn: AgentLoopRunTurn = async (_ep, messages) => {
    seen.push(messages.map((m) => m.content));
    return (turns[i++] ?? { text: "", toolCalls: [] }) as ChatTurnResult;
  };
  const h = baseDeps(runTurn);
  const deps = signal ? { ...h.deps, signal } : h.deps;
  return { deps, calls: () => i, notes: h.notes };
}

test("pause→resume: the command's stdout/exit feed back and the model continues", async () => {
  const seen: string[][] = [];
  const s = scripted(
    [
      {
        text: "",
        toolCalls: [
          { id: "1", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) },
        ],
      },
      { text: "all green ✓", toolCalls: [] },
    ],
    seen,
  );
  const paused = await runAgentLoop([{ role: "user", content: "run tests" }], s.deps as never);
  assert.equal(paused.status, "paused");
  if (paused.status !== "paused") return;
  assert.deepEqual(paused.pending, [{ command: "npm test" }]);
  assert.equal(paused.itersUsed, 1);

  const done = await resumeAgentLoop(
    paused,
    [{ command: "npm test", stdout: "3 passed", exit: 0 }],
    s.deps as never,
  );
  assert.equal(done.status, "done");
  // the resumed turn (seen[1]) received the tool result with exit + stdout.
  const resumedMsgs = seen[1]?.join("\n") ?? "";
  assert.ok(resumedMsgs.includes("[tool run_command npm test]"));
  assert.ok(resumedMsgs.includes("exit 0"));
  assert.ok(resumedMsgs.includes("3 passed"));
});

test("denial resume: a denied command feeds a denial note (no dead-end)", async () => {
  const seen: string[][] = [];
  const s = scripted(
    [
      {
        text: "",
        toolCalls: [
          { id: "1", name: "run_command", arguments: JSON.stringify({ command: "rm -rf /" }) },
        ],
      },
      { text: "understood, I'll avoid that.", toolCalls: [] },
    ],
    seen,
  );
  const paused = await runAgentLoop([{ role: "user", content: "clean" }], s.deps as never);
  if (paused.status !== "paused") throw new Error("expected paused");
  const done = await resumeAgentLoop(
    paused,
    [{ command: "rm -rf /", denied: true }],
    s.deps as never,
  );
  assert.equal(done.status, "done");
  assert.ok((seen[1]?.join("\n") ?? "").includes("denied by user"));
});

test("multiple pending commands in one turn resume together in call order", async () => {
  const seen: string[][] = [];
  const s = scripted(
    [
      {
        text: "",
        toolCalls: [
          { id: "1", name: "run_command", arguments: JSON.stringify({ command: "build" }) },
          { id: "2", name: "run_command", arguments: JSON.stringify({ command: "lint" }) },
        ],
      },
      { text: "both ran.", toolCalls: [] },
    ],
    seen,
  );
  const paused = await runAgentLoop([{ role: "user", content: "ci" }], s.deps as never);
  if (paused.status !== "paused") throw new Error("expected paused");
  assert.equal(paused.pending.length, 2);
  const done = await resumeAgentLoop(
    paused,
    [
      { command: "build", stdout: "built", exit: 0 },
      { command: "lint", stderr: "1 warning", exit: 0 },
    ],
    s.deps as never,
  );
  assert.equal(done.status, "done");
  const msg = seen[1]?.join("\n") ?? "";
  const iBuild = msg.indexOf("[tool run_command build]");
  const iLint = msg.indexOf("[tool run_command lint]");
  assert.ok(iBuild >= 0 && iLint >= 0 && iBuild < iLint, "results appended in call order");
});

test("resume honors the remaining iter budget (no fresh budget → no infinite loop)", async () => {
  const seen: string[][] = [];
  const s = scripted(
    [
      {
        text: "",
        toolCalls: [{ id: "1", name: "run_command", arguments: JSON.stringify({ command: "x" }) }],
      },
      { text: "should not be reached", toolCalls: [] },
    ],
    seen,
  );
  const deps = { ...(s.deps as object), maxIters: 1 };
  const paused = await runAgentLoop([{ role: "user", content: "go" }], deps as never);
  if (paused.status !== "paused") throw new Error("expected paused");
  assert.equal(paused.itersUsed, 1);
  const done = await resumeAgentLoop(paused, [{ command: "x", exit: 0 }], deps as never);
  assert.equal(done.status, "done");
  assert.equal(s.calls(), 1, "resume did NOT call the model again (budget exhausted)");
  assert.ok(s.notes().some((n) => n.includes("step limit")));
});

test("abort-while-paused: resume drops cleanly, never calls the model", async () => {
  const seen: string[][] = [];
  const ac = new AbortController();
  const s = scripted(
    [
      {
        text: "",
        toolCalls: [{ id: "1", name: "run_command", arguments: JSON.stringify({ command: "x" }) }],
      },
      { text: "unreached", toolCalls: [] },
    ],
    seen,
    ac.signal,
  );
  const paused = await runAgentLoop([{ role: "user", content: "go" }], s.deps as never);
  if (paused.status !== "paused") throw new Error("expected paused");
  ac.abort(); // the user hit stop / re-prompted while awaiting approval
  const done = await resumeAgentLoop(paused, [{ command: "x", exit: 0 }], s.deps as never);
  assert.equal(done.status, "done");
  assert.equal(s.calls(), 1, "no resumed model call after abort");
});

test("formatCommandResult mirrors the tool envelope; truncateMiddle keeps head+tail", () => {
  const ok = formatCommandResult({ command: "npm test", stdout: "PASS", exit: 0 });
  assert.ok(ok.startsWith("[tool run_command npm test]"));
  assert.ok(ok.includes("exit 0") && ok.includes("stdout:\nPASS"));
  const denied: CommandResult = { command: "danger", denied: true };
  assert.ok(formatCommandResult(denied).includes("denied by user"));
  const big = truncateMiddle(`${"A".repeat(5000)}TAILMARKER`, 200);
  assert.ok(big.length < 400);
  assert.ok(big.includes("TAILMARKER"), "tail (error/exit context) preserved");
  assert.ok(big.includes("elided"));
});

test("parseToolArgs is defensive", () => {
  assert.deepEqual(parseToolArgs({ id: "1", name: "x", arguments: '{"a":1}' }), { a: 1 });
  assert.deepEqual(parseToolArgs({ id: "1", name: "x", arguments: "garbage" }), {});
  assert.deepEqual(parseToolArgs({ id: "1", name: "x", arguments: "[1,2]" }), {});
  assert.deepEqual(parseToolArgs({ id: "1", name: "x", arguments: "" }), {});
});

test("AGENT_TOOLS offers read_file / list_dir / grep / propose_edit / run_command", () => {
  const names = AGENT_TOOLS.map((t) => (t as { function: { name: string } }).function.name).sort();
  assert.deepEqual(names, ["grep", "list_dir", "propose_edit", "read_file", "run_command"]);
});

/* ── propose_edit: path guard ─────────────────────────────────────────────── */

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

test("propose_edit dispatches to tools.proposeEdit, feeds the note back, does NOT pause", async () => {
  const seen: string[][] = [];
  const turns: ChatTurnResult[] = [
    {
      text: "",
      toolCalls: [
        {
          id: "1",
          name: "propose_edit",
          arguments: JSON.stringify({
            path: "src/a.ts",
            edits: [{ oldText: "x", newText: "y" }],
          }),
        },
      ],
    },
    { text: "done.", toolCalls: [] },
  ];
  let i = 0;
  const runTurn: AgentLoopRunTurn = async (_ep, messages) => {
    seen.push(messages.map((m) => m.content));
    return turns[i++] as ChatTurnResult;
  };
  const h = baseDeps(runTurn);
  await runAgentLoop([{ role: "user", content: "edit a.ts" }], h.deps as never);
  assert.equal(i, 2); // the loop CONTINUED after the edit (review is async — no pause)
  assert.deepEqual(h.proposedEdits(), [
    { path: "src/a.ts", spans: [{ oldText: "x", newText: "y" }], description: undefined },
  ]);
  assert.ok(seen[1]?.some((c) => c.includes("✓ proposed 1 edit to src/a.ts")));
  assert.ok(h.notes().some((n) => n.includes("✎ edit src/a.ts")));
});

test("propose_edit with a bad path is rejected client-side (tool impl never called)", async () => {
  const seen: string[][] = [];
  const turns: ChatTurnResult[] = [
    {
      text: "",
      toolCalls: [
        {
          id: "1",
          name: "propose_edit",
          arguments: JSON.stringify({
            path: "../../etc/passwd",
            edits: [{ oldText: "", newText: "pwn" }],
          }),
        },
      ],
    },
    { text: "ok", toolCalls: [] },
  ];
  let i = 0;
  const runTurn: AgentLoopRunTurn = async (_ep, messages) => {
    seen.push(messages.map((m) => m.content));
    return turns[i++] as ChatTurnResult;
  };
  const h = baseDeps(runTurn);
  await runAgentLoop([{ role: "user", content: "edit" }], h.deps as never);
  assert.equal(h.proposedEdits().length, 0);
  assert.ok(seen[1]?.some((c) => c.includes("[tool propose_edit] error:")));
});

/* ── propose_edit: ChangeSet accumulation + the fail-closed zero-write guarantee ── */

test("createProposeEditTool accumulates the turn's edits into ONE ChangeSet", async () => {
  const dispatched: { id: string; rationale: string; edits: { uri: string }[] }[] = [];
  const files: Record<string, string> = { "file:///w/a.ts": "aaa\nbbb" };
  const tool = createProposeEditTool({
    changeSetId: "cs-1",
    toUri: (rel) => `file:///w/${rel}`,
    readOriginal: async (uri) => files[uri] ?? null,
    dispatch: (cs) => dispatched.push(cs),
  });
  const r1 = await tool({ path: "a.ts", spans: [{ oldText: "aaa", newText: "AAA" }] });
  assert.match(r1, /^✓/);
  const r2 = await tool({
    path: "new.ts",
    spans: [{ oldText: "", newText: "fresh" }],
    description: "add new.ts",
  });
  assert.match(r2, /new file/);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1]?.id, "cs-1");
  assert.equal(dispatched[1]?.rationale, "add new.ts");
  assert.deepEqual(
    dispatched[1]?.edits.map((e) => e.uri),
    ["file:///w/a.ts", "file:///w/new.ts"],
  );
  // a second edit to the SAME existing file merges (anchored to the same original)…
  const r3 = await tool({ path: "a.ts", spans: [{ oldText: "bbb", newText: "BBB" }] });
  assert.match(r3, /^✓/);
  assert.equal(dispatched[2]?.edits.length, 2);
  const aHunks = dispatched[2]?.edits.find((e) => e.uri === "file:///w/a.ts") as {
    hunks: unknown[];
  };
  assert.equal(aHunks.hunks.length, 2);
  // …but re-touching already-claimed lines is refused.
  const r4 = await tool({ path: "a.ts", spans: [{ oldText: "aaa", newText: "zzz" }] });
  assert.match(r4, /already touches/);
});

test("a full propose_edit turn performs ZERO writes on the entire ide api surface", async () => {
  // spy the WHOLE surface: every method call is recorded; only fsRead may fire.
  const calls: string[] = [];
  const spied = (name: string, ret: unknown) => {
    return (..._a: unknown[]) => {
      calls.push(name);
      return Promise.resolve(ret);
    };
  };
  const api = {
    fsRead: spied("fsRead", { ok: true, text: "old line" }),
    fsWrite: spied("fsWrite", { ok: true }),
    fsTree: spied("fsTree", []),
    exec: spied("exec", { ok: true }),
    search: spied("search", { ok: true, matches: [] }),
  };
  const dispatched: unknown[] = [];
  const tool = createProposeEditTool({
    changeSetId: "cs-z",
    toUri: (rel) => `file:///w/${rel}`,
    readOriginal: async (uri) => {
      const r = (await api.fsRead(uri)) as { ok: boolean; text?: string };
      return r.ok && typeof r.text === "string" ? r.text : null;
    },
    dispatch: (cs) => dispatched.push(cs),
  });
  const turns: ChatTurnResult[] = [
    {
      text: "",
      toolCalls: [
        {
          id: "1",
          name: "propose_edit",
          arguments: JSON.stringify({
            path: "a.ts",
            edits: [{ oldText: "old line", newText: "new line" }],
          }),
        },
      ],
    },
    { text: "done", toolCalls: [] },
  ];
  let i = 0;
  const h = baseDeps(async () => turns[i++] as ChatTurnResult, {
    proposeEdit: tool,
  });
  await runAgentLoop([{ role: "user", content: "edit" }], h.deps as never);
  assert.equal(dispatched.length, 1); // the ChangeSet reached the store seam…
  assert.deepEqual(calls, ["fsRead"]); // …and the ONLY api touch was the baselining read
});

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
