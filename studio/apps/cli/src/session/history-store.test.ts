/**
 * history-store.test.ts — the /recall session-history descriptor + record/list/format.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type AccountingRecord,
  aggregateAccounting,
  appendAccounting,
  appendTurnEvents,
  buildSessionExport,
  deleteSession,
  descriptorOf,
  forkSession,
  formatPicker,
  listSessions,
  loadTurns,
  readAccounting,
  recordSession,
  resolveSessionId,
  rotateSessions,
  safeSessionId,
  searchSessions,
} from "./history-store.js";

test("descriptorOf takes the first 15 words, hard-chunked + ellipsized", () => {
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join("  ");
  const d = descriptorOf(long);
  assert.equal(d.split(" ").length, 15);
  assert.ok(d.endsWith("…"));
  // short prompt is returned whole, no ellipsis; whitespace collapsed.
  assert.equal(descriptorOf("  build   a parser  "), "build a parser");
  assert.equal(descriptorOf("   "), "(empty prompt)");
});

test("record → list is newest-first + survives a corrupt line", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-recall-"));
  try {
    recordSession(home, {
      id: "aaa11111",
      ts: "2026-06-26T10:00:00Z",
      descriptor: "first",
      cwd: "/a",
    });
    recordSession(home, {
      id: "bbb22222",
      ts: "2026-06-26T11:00:00Z",
      descriptor: "second",
      cwd: "/b",
    });
    // a junk line must be skipped, not crash the reader.
    appendFileSync(join(home, "sessions", "index.jsonl"), "{not json\n");
    const recs = listSessions(home);
    assert.equal(recs.length, 2);
    assert.equal(recs[0]?.id, "bbb22222"); // newest first
    assert.equal(recs[1]?.descriptor, "first");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listSessions on a missing home is empty (fail-soft)", () => {
  assert.deepEqual(listSessions("/no/such/home/here"), []);
});

test("formatPicker renders ids + descriptors, or an empty message", () => {
  assert.match(formatPicker([]), /No past sessions/);
  const out = formatPicker([
    { id: "deadbeef0000", ts: "2026-06-26T09:30:00Z", descriptor: "make a thing", cwd: "/x" },
  ]);
  assert.match(out, /deadbeef/);
  assert.match(out, /make a thing/);
  assert.match(out, /Pick a number/);
});

/* ── CLI-012: per-session TURN transcripts ─────────────────────────────────── */

test("safeSessionId: allowlist rejects escapes / reserved names", () => {
  assert.equal(safeSessionId("abc-123_XY"), "abc-123_XY");
  assert.equal(safeSessionId(".."), null);
  assert.equal(safeSessionId("a/b"), null);
  assert.equal(safeSessionId("a.b"), null);
  assert.equal(safeSessionId(""), null);
  assert.equal(safeSessionId("con"), null); // Windows reserved (case-insensitive)
});

test("appendTurnEvents → loadTurns round-trips order + payload (CLI-012)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-turns-"));
  try {
    let n = 0;
    const clock = () => `2026-06-26T10:00:0${n++}.000Z`;
    appendTurnEvents(
      home,
      "sess1",
      [
        { role: "user", text: "hi there" },
        { kind: "text", text: "hello back" },
        { kind: "tool_use", call: { name: "prometheus_scan" } },
        { kind: "tool_result", ok: true, summary: "scan: ok" },
      ],
      clock,
    );
    const turns = loadTurns(home, "sess1");
    assert.equal(turns.length, 4);
    assert.equal(turns[0]?.role, "user");
    assert.equal(turns[0]?.text, "hi there");
    assert.equal(turns[1]?.kind, "text");
    assert.equal(turns[3]?.summary, "scan: ok");
    assert.equal(turns[0]?.ts, "2026-06-26T10:00:00.000Z"); // stamped in order
    // missing session → []
    assert.deepEqual(loadTurns(home, "nope"), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadTurns skips a corrupt/truncated line, keeps the rest (CLI-012)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-turns2-"));
  try {
    appendTurnEvents(home, "s", [{ role: "user", text: "a" }]);
    appendFileSync(join(home, "sessions", "s.jsonl"), "{ truncated\n"); // crash-mid-write
    appendTurnEvents(home, "s", [{ kind: "text", text: "b" }]);
    const turns = loadTurns(home, "s");
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.text, "a");
    assert.equal(turns[1]?.text, "b");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rotateSessions deletes oldest, never the live file nor index (CLI-012)", () => {
  const removed: string[] = [];
  // 3 files @ 40 bytes each = 120 > cap 100; live=c, so oldest (a) is pruned first.
  const files: Record<string, { size: number; mtimeMs: number }> = {
    "a.jsonl": { size: 40, mtimeMs: 1 },
    "b.jsonl": { size: 40, mtimeMs: 2 },
    "c.jsonl": { size: 40, mtimeMs: 3 },
    "index.jsonl": { size: 999, mtimeMs: 0 },
  };
  rotateSessions("/home", {
    maxBytes: 100,
    liveId: "c",
    listDir: () => Object.keys(files),
    statFn: (p) => files[p.split("/").pop() as string] as { size: number; mtimeMs: number },
    rmFn: (p) => removed.push(p.split("/").pop() as string),
  });
  assert.deepEqual(removed, ["a.jsonl"]); // oldest non-live pruned; b/c/index kept
});

test("appendTurnEvents on a read-only home degrades silently (CLI-012)", () => {
  assert.doesNotThrow(() =>
    appendTurnEvents("/no/such/root/xyz", "s", [{ role: "user", text: "x" }]),
  );
});

/* ── CLI-014: session browser resolve / search / fork / delete ─────────────── */

test("resolveSessionId: exact, prefix, ambiguous, none", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-res-"));
  try {
    recordSession(home, { id: "abc12345", ts: "2026-06-26T10:00:00Z", descriptor: "x", cwd: "/a" });
    recordSession(home, { id: "abc99999", ts: "2026-06-26T11:00:00Z", descriptor: "y", cwd: "/b" });
    recordSession(home, { id: "zzz00000", ts: "2026-06-26T12:00:00Z", descriptor: "z", cwd: "/c" });
    assert.deepEqual(resolveSessionId(home, "zzz00000"), { id: "zzz00000" }); // exact
    assert.deepEqual(resolveSessionId(home, "zzz"), { id: "zzz00000" }); // unique prefix
    assert.ok("error" in resolveSessionId(home, "abc")); // ambiguous
    assert.ok("error" in resolveSessionId(home, "qqq")); // none
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("searchSessions matches transcript content, not just descriptor", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-search-"));
  try {
    recordSession(home, {
      id: "s1aaaaaa",
      ts: "2026-06-26T10:00:00Z",
      descriptor: "parser work",
      cwd: "/a",
    });
    appendTurnEvents(home, "s1aaaaaa", [{ kind: "text", text: "using the KEYWORD_XYZ token" }]);
    recordSession(home, {
      id: "s2bbbbbb",
      ts: "2026-06-26T11:00:00Z",
      descriptor: "unrelated",
      cwd: "/b",
    });
    const byText = searchSessions(home, "keyword_xyz"); // case-insensitive, transcript-only
    assert.equal(byText.length, 1);
    assert.equal(byText[0]?.id, "s1aaaaaa");
    // descriptor match too
    assert.equal(searchSessions(home, "unrelated").length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("forkSession makes an INDEPENDENT copy (append to fork ≠ mutate source)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-fork-"));
  try {
    recordSession(home, {
      id: "src11111",
      ts: "2026-06-26T10:00:00Z",
      descriptor: "orig",
      cwd: "/a",
    });
    appendTurnEvents(home, "src11111", [{ role: "user", text: "hello" }]);
    let seq = 0;
    const r = forkSession(
      home,
      "src11111",
      () => `fork${seq++}`,
      () => "2026-06-26T12:00:00Z",
    );
    assert.ok(!("error" in r));
    const newId = (r as { newId: string }).newId;
    const srcBefore = loadTurns(home, "src11111").length;
    // append to the FORK only
    appendTurnEvents(home, newId, [{ role: "user", text: "fork-only turn" }]);
    assert.equal(loadTurns(home, "src11111").length, srcBefore, "source unchanged");
    assert.equal(loadTurns(home, newId).length, srcBefore + 1, "fork diverged");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("deleteSession removes transcript + index entry", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-del-"));
  try {
    recordSession(home, {
      id: "del11111",
      ts: "2026-06-26T10:00:00Z",
      descriptor: "gone",
      cwd: "/a",
    });
    appendTurnEvents(home, "del11111", [{ role: "user", text: "bye" }]);
    recordSession(home, {
      id: "keep2222",
      ts: "2026-06-26T11:00:00Z",
      descriptor: "stays",
      cwd: "/b",
    });
    assert.equal(deleteSession(home, "del11111"), true);
    assert.deepEqual(loadTurns(home, "del11111"), []); // transcript gone
    assert.deepEqual(
      listSessions(home).map((r) => r.id),
      ["keep2222"],
    ); // index pruned
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── CLI-029: per-session token accounting ────────────────────────────────── */

const acct = (over: Partial<AccountingRecord> = {}): AccountingRecord => ({
  model: "qwen2.5-coder",
  endpointId: "local:qwen@vllm",
  promptTokens: 10,
  completionTokens: 5,
  estimated: false,
  atIso: "2026-07-17T09:00:00.000Z",
  ...over,
});

test("appendAccounting → readAccounting round-trips + survives a fresh store (restart)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-acct-"));
  try {
    appendAccounting(home, "sess1234", acct({ promptTokens: 11, completionTokens: 4 }));
    appendAccounting(
      home,
      "sess1234",
      acct({ promptTokens: 20, completionTokens: 8, estimated: true }),
    );
    // a FRESH read (no shared instance) sees both — persisted across "restart".
    const recs = readAccounting(home, "sess1234");
    assert.equal(recs.length, 2);
    assert.equal(recs[0]?.promptTokens, 11);
    assert.equal(recs[0]?.estimated, false);
    assert.equal(recs[1]?.estimated, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readAccounting is corrupt-tolerant (bad line skipped, never throws)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-acct-"));
  try {
    appendAccounting(home, "sx", acct());
    appendFileSync(join(home, "sessions", "sx.acct.jsonl"), "{ not json ::\n");
    appendAccounting(home, "sx", acct({ promptTokens: 99 }));
    const recs = readAccounting(home, "sx");
    assert.equal(recs.length, 2, "the corrupt middle line is skipped, the rest survive");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readAccounting: missing file → [] (fail-soft); unsafe id → []", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-acct-"));
  try {
    assert.deepEqual(readAccounting(home, "never"), []);
    assert.deepEqual(readAccounting(home, "../evil"), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("aggregateAccounting totals per model + per day; estimated flag propagates", () => {
  const recs: AccountingRecord[] = [
    acct({ model: "a", promptTokens: 10, completionTokens: 2, atIso: "2026-07-17T01:00:00Z" }),
    acct({ model: "a", promptTokens: 5, completionTokens: 1, atIso: "2026-07-17T02:00:00Z" }),
    acct({
      model: "b",
      promptTokens: 7,
      completionTokens: 3,
      estimated: true,
      atIso: "2026-07-18T01:00:00Z",
    }),
  ];
  const agg = aggregateAccounting(recs);
  assert.equal(agg.byModel.a?.promptTokens, 15);
  assert.equal(agg.byModel.a?.turns, 2);
  assert.equal(agg.byModel.a?.estimated, false);
  assert.equal(agg.byModel.b?.estimated, true);
  assert.equal(agg.byDay["2026-07-17"]?.turns, 2);
  assert.equal(agg.byDay["2026-07-18"]?.completionTokens, 3);
  assert.equal(agg.total.promptTokens, 22);
  assert.equal(agg.total.completionTokens, 6);
  assert.equal(agg.total.estimated, true); // ANY estimate → total is a floor
});

/* ── CLI-082: structured transcript export ─────────────────────────────────────── */

test("buildSessionExport CLI-082: groups user + assistant turns, folds tool_use/verdict, ISO at", () => {
  const turns = [
    { ts: "2026-07-18T00:00:01.000Z", role: "user", text: "scan this" },
    { ts: "2026-07-18T00:00:02.000Z", kind: "text", text: "on it… " },
    {
      ts: "2026-07-18T00:00:03.000Z",
      kind: "tool_use",
      call: { name: "prometheus_scan", args: { t: "x" } },
    },
    {
      ts: "2026-07-18T00:00:04.000Z",
      kind: "verdict",
      tool: "prometheus_scan",
      verdict: "block",
      riskScore: 88,
    },
    { ts: "2026-07-18T00:00:05.000Z", kind: "text", text: "blocked." },
  ];
  const doc = buildSessionExport("sess-1", turns, "2026-07-18T00:01:00.000Z");
  assert.equal(doc.sessionId, "sess-1");
  assert.match(doc.exportedAt, /Z$/); // ISO-8601 UTC
  assert.equal(doc.turns.length, 2); // one user + one collapsed assistant
  assert.deepEqual(doc.turns[0], {
    role: "user",
    text: "scan this",
    at: "2026-07-18T00:00:01.000Z",
  });
  const a = doc.turns[1];
  assert.equal(a?.role, "assistant");
  assert.equal(a?.text, "on it… blocked."); // text deltas concatenated
  assert.match(a?.at ?? "", /Z$/);
  assert.deepEqual(a?.toolCalls, [{ name: "prometheus_scan", args: { t: "x" } }]);
  assert.deepEqual(a?.verdict, [{ tool: "prometheus_scan", verdict: "block", riskScore: 88 }]);
});

test("buildSessionExport CLI-082: an empty session → valid turns:[] (not [null] / a crash)", () => {
  const doc = buildSessionExport("empty", [], "2026-07-18T00:00:00.000Z");
  assert.deepEqual(doc, { sessionId: "empty", exportedAt: "2026-07-18T00:00:00.000Z", turns: [] });
  // round-trips through JSON.stringify cleanly (no circular / undefined-hole).
  const parsed = JSON.parse(JSON.stringify(doc, null, 2));
  assert.deepEqual(parsed.turns, []);
});

test("buildSessionExport CLI-082: loadTurns → export round-trip from a persisted session", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-export-"));
  try {
    appendTurnEvents(home, "s9", [
      { role: "user", text: "hi" },
      { kind: "text", text: "hello" },
    ]);
    const doc = buildSessionExport("s9", loadTurns(home, "s9"), "2026-07-18T00:00:00.000Z");
    assert.equal(doc.turns.length, 2);
    assert.equal(doc.turns[0]?.text, "hi");
    assert.equal(doc.turns[1]?.text, "hello");
    assert.match(doc.turns[0]?.at ?? "", /Z$/); // appendTurnEvents stamped a real ISO ts
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
