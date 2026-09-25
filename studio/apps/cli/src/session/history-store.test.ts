/**
 * history-store.test.ts — the /recall session-history descriptor + record/list/format.
 */
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
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
  readAccountingSince,
  recordSession,
  resolveSessionId,
  rotateSessions,
  safeSessionId,
  searchSessions,
  updateSessionSummary,
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
  assert.match(out, /deadbeef0000/); // the FULL id, not a sliced prefix
  assert.match(out, /make a thing/);
  assert.match(out, /Pick a number/);
});

test("formatPicker prefers lastSummary over descriptor when both are present", () => {
  const out = formatPicker([
    {
      id: "abc1234567",
      ts: "2026-06-26T09:30:00Z",
      descriptor: "the very first prompt",
      lastSummary: "edited 2 files · ran 1 command — fix the bug",
      cwd: "/x",
    },
  ]);
  assert.match(out, /edited 2 files/);
  assert.doesNotMatch(out, /the very first prompt/);
});

test("formatPicker column-aligns ids of differing width across records", () => {
  const out = formatPicker([
    { id: "short1", ts: "2026-06-26T09:30:00Z", descriptor: "aaa", cwd: "/x" },
    {
      id: "a-much-longer-session-id-0123456789",
      ts: "2026-06-26T09:31:00Z",
      descriptor: "bbb",
      cwd: "/x",
    },
  ]);
  const lines = out.split("\n").filter((l) => /^\s+\d+\)/.test(l));
  assert.equal(lines.length, 2);
  // both summaries ("aaa"/"bbb") start at the same column once the shorter id is padded out.
  assert.equal(lines[0]?.indexOf("aaa"), lines[1]?.indexOf("bbb"));
});

test("updateSessionSummary refreshes lastSummary in place; a missing id / unreadable home is a no-op", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-recall-summary-"));
  try {
    recordSession(home, { id: "s1", ts: "2026-06-26T10:00:00Z", descriptor: "first", cwd: "/a" });
    recordSession(home, { id: "s2", ts: "2026-06-26T11:00:00Z", descriptor: "second", cwd: "/b" });
    updateSessionSummary(home, "s1", "edited 1 file — first");
    const recs = listSessions(home);
    assert.equal(recs.find((r) => r.id === "s1")?.lastSummary, "edited 1 file — first");
    assert.equal(recs.find((r) => r.id === "s2")?.lastSummary, undefined);
    // a second update on the same id overwrites, not appends.
    updateSessionSummary(home, "s1", "ran 1 command — first");
    assert.equal(
      listSessions(home).find((r) => r.id === "s1")?.lastSummary,
      "ran 1 command — first",
    );
    // an unknown id is a no-op, not a crash or a new record.
    updateSessionSummary(home, "no-such-id", "whatever");
    assert.equal(listSessions(home).length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  // an unreadable home must not throw.
  assert.doesNotThrow(() => updateSessionSummary("/no/such/home/here", "s1", "x"));
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
  // `now` is pinned near the fixture mtimes so the AGE policy is not what fires here — this
  // test is about the byte cap, and the age rule gets its own test below.
  const files: Record<string, { size: number; mtimeMs: number }> = {
    "a.jsonl": { size: 40, mtimeMs: 1 },
    "b.jsonl": { size: 40, mtimeMs: 2 },
    "c.jsonl": { size: 40, mtimeMs: 3 },
    "index.jsonl": { size: 999, mtimeMs: 0 },
  };
  rotateSessions("/home", {
    maxBytes: 100,
    liveId: "c",
    now: 100,
    listDir: () => Object.keys(files),
    statFn: (p) => files[p.split("/").pop() as string] as { size: number; mtimeMs: number },
    rmFn: (p) => removed.push(p.split("/").pop() as string),
    writeFn: () => {},
  });
  assert.deepEqual(removed, ["a.jsonl"]); // oldest non-live pruned; b/c/index kept
});

test("retention covers ACCOUNTING too — it used to be exempt and therefore unbounded", () => {
  // `*.acct.jsonl` was filtered out of the candidate list entirely, so accounting grew forever.
  // Worst in CI: every `prometheus -p` mints a fresh session id, writes an accounting file,
  // records no index entry — so `sessions delete` can never reach it — and leaked one per run.
  const removed: string[] = [];
  const now = Date.now();
  const old = now - 40 * 24 * 60 * 60 * 1000; // well before today, so nothing is cap evidence
  const files: Record<string, { size: number; mtimeMs: number }> = {
    "oldrun.jsonl": { size: 10, mtimeMs: old },
    "oldrun.acct.jsonl": { size: 90, mtimeMs: old },
    "live.jsonl": { size: 10, mtimeMs: now },
    "index.jsonl": { size: 999, mtimeMs: 0 },
  };
  rotateSessions("/home", {
    maxBytes: 50,
    liveId: "live",
    now,
    listDir: () => Object.keys(files),
    statFn: (p) => files[p.split("/").pop() as string] as { size: number; mtimeMs: number },
    rmFn: (p) => removed.push(p.split("/").pop() as string),
    writeFn: () => {},
  });
  assert.deepEqual(removed.sort(), ["oldrun.acct.jsonl", "oldrun.jsonl"]);
});

test("TODAY's accounting is never pruned — it is the daily spend cap's evidence", () => {
  // `checkBudgetGate` measures the daily cap by reading these files. Pruning one silently
  // re-opens the cap, which is the one failure mode a spend limit may not have.
  const removed: string[] = [];
  const now = Date.now();
  const files: Record<string, { size: number; mtimeMs: number }> = {
    "today.acct.jsonl": { size: 10_000, mtimeMs: now },
    "index.jsonl": { size: 1, mtimeMs: 0 },
  };
  rotateSessions("/home", {
    maxBytes: 1,
    liveId: "other",
    now,
    listDir: () => Object.keys(files),
    statFn: (p) => files[p.split("/").pop() as string] as { size: number; mtimeMs: number },
    rmFn: (p) => removed.push(p.split("/").pop() as string),
    writeFn: () => {},
  });
  assert.deepEqual(removed, [], "today's accounting was pruned — the daily cap is now bypassable");
});

test("an OLD session is pruned even when the store is well under the byte cap", () => {
  const removed: string[] = [];
  const now = Date.now();
  const ancient = now - 400 * 24 * 60 * 60 * 1000;
  const files: Record<string, { size: number; mtimeMs: number }> = {
    "ancient.jsonl": { size: 1, mtimeMs: ancient },
    "recent.jsonl": { size: 1, mtimeMs: now },
    "index.jsonl": { size: 1, mtimeMs: 0 },
  };
  rotateSessions("/home", {
    maxBytes: 10_000_000,
    liveId: "recent",
    now,
    listDir: () => Object.keys(files),
    statFn: (p) => files[p.split("/").pop() as string] as { size: number; mtimeMs: number },
    rmFn: (p) => removed.push(p.split("/").pop() as string),
    writeFn: () => {},
  });
  assert.deepEqual(removed, ["ancient.jsonl"]);
});

test("index.jsonl is pruned in the same pass, so /recall stops offering dead sessions", () => {
  // The index was pruned only by an explicit delete, so it grew a line per launch and `/recall`
  // listed sessions whose transcripts rotation had already removed.
  const home = mkdtempSync(join(tmpdir(), "prom-idx-"));
  recordSession(home, { id: "gone", ts: "2020-01-01T00:00:00Z", descriptor: "old", cwd: "/w" });
  recordSession(home, { id: "live", ts: "2026-01-01T00:00:00Z", descriptor: "new", cwd: "/w" });
  appendTurnEvents(home, "gone", [{ role: "user", text: "x" }]);
  appendTurnEvents(home, "live", [{ role: "user", text: "y" }]);
  rotateSessions(home, { maxBytes: 0, liveId: "live", now: Date.now() });
  assert.deepEqual(
    listSessions(home).map((r) => r.id),
    ["live"],
    "a session whose transcript was pruned is still offered by /recall",
  );
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

/* ── accounting: absent vs unreadable, and the whole day ───────────────────*/

/**
 * Two defects, both found by an adversarial pass:
 *
 *  - `readAccounting` swallowed EVERY read error and returned `[]`, so an unreadable store read
 *    as "$0 spent". `checkBudgetGate` documents itself as failing CLOSED on exactly that — so the
 *    guarantee was inverted into a one-command cap bypass (`rm` the file).
 *  - `daily_usd` was evaluated from the CURRENT session's file only, and a fresh sessionId is
 *    minted every launch — so the "daily" window reset to $0 on restart.
 */

const acctRec = (over: Partial<AccountingRecord> = {}): AccountingRecord => ({
  model: "m",
  endpointId: "e",
  promptTokens: 10,
  completionTokens: 20,
  estimated: false,
  atIso: new Date().toISOString(),
  ...over,
});

test("a store that was never written reads as empty — the normal first run", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-acct-"));
  assert.deepEqual(readAccounting(home, "never-ran"), []);
});

test("an UNREADABLE store THROWS rather than reading as $0 spent", () => {
  // This is the whole fail-closed guarantee. Returning [] here is a cap bypass.
  const home = mkdtempSync(join(tmpdir(), "prom-acct-"));
  appendAccounting(home, "s1", acctRec());
  const file = join(home, "sessions", "s1.acct.jsonl");
  chmodSync(file, 0o000);
  try {
    assert.throws(() => readAccounting(home, "s1"));
  } finally {
    chmodSync(file, 0o600); // so the tmpdir can be cleaned
  }
});

test("the day window spans EVERY session, not just the current one", () => {
  // A fresh sessionId per launch is why `daily_usd` reset on restart.
  const home = mkdtempSync(join(tmpdir(), "prom-acct-"));
  appendAccounting(home, "yesterdaysession", acctRec({ model: "a" }));
  appendAccounting(home, "todaysession", acctRec({ model: "b" }));
  const all = readAccountingSince(home, 0);
  assert.deepEqual(all.map((r) => r.model).sort(), ["a", "b"]);
});

test("a LOCAL turn stays out of the shared ledger but still counts for the CLI", () => {
  // The desktop gate prices shared rows; a bare local id ("gemma3:4b") prices as UNKNOWN there,
  // so one local CLI turn blocked every Studio cloud call for the day with budget.dailyUsd set.
  const home = mkdtempSync(join(tmpdir(), "prom-acct-"));
  appendAccounting(home, "s1", acctRec({ model: "gemma3:4b" }), { metered: false });
  appendAccounting(home, "s1", acctRec({ model: "claude-x" }));
  const sharedDir = join(home, "accounting");
  const sharedRows = readdirSync(sharedDir)
    .flatMap((f) => readFileSync(join(sharedDir, f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { model: string }).model);
  assert.deepEqual(sharedRows, ["claude-x"], "only the metered row is shared");
  const mine = readAccountingSince(home, 0)
    .map((r) => r.model)
    .sort();
  assert.deepEqual(mine, ["claude-x", "gemma3:4b"], "the CLI's own window still sees both");
});

test("a session file older than the window is not even opened", () => {
  // The cost bound: a file whose last write predates the window cannot hold a record in it.
  //
  // The record's OWN `atIso` is backdated too, not just the file's mtime. mtime is a cheap
  // proxy used to avoid opening the file at all; the shared daily ledger keys off the row's
  // timestamp instead, so a fixture that backdated only the file described a record that is
  // simultaneously "from yesterday" (by mtime) and "from four minutes ago" (by content). The
  // two readers then disagreed, correctly. Backdating both makes the fixture mean one thing.
  const home = mkdtempSync(join(tmpdir(), "prom-acct-"));
  const dayAgo = Date.now() - 86_400_000;
  appendAccounting(home, "old", acctRec({ atIso: new Date(dayAgo).toISOString() }));
  const file = join(home, "sessions", "old.acct.jsonl");
  const past = new Date(dayAgo);
  utimesSync(file, past, past);
  assert.deepEqual(readAccountingSince(home, Date.now() - 3600_000), []);
});

test("one unreadable session does not make the whole day unreadable", () => {
  // Fail-soft ACROSS sessions, fail-closed WITHIN the current one — the two callers want
  // different things and get them.
  const home = mkdtempSync(join(tmpdir(), "prom-acct-"));
  appendAccounting(home, "good", acctRec({ model: "good" }));
  appendAccounting(home, "bad", acctRec({ model: "bad" }));
  const badFile = join(home, "sessions", "bad.acct.jsonl");
  chmodSync(badFile, 0o000);
  try {
    assert.deepEqual(
      readAccountingSince(home, 0).map((r) => r.model),
      ["good"],
    );
  } finally {
    chmodSync(badFile, 0o600);
  }
});

test("no sessions directory at all is empty, never a throw", () => {
  assert.deepEqual(readAccountingSince(mkdtempSync(join(tmpdir(), "prom-acct-")), 0), []);
});

test("today's accounting survives while its transcript is pruned — evidence, not bulk", () => {
  // The protection is on the FILE, not the session: the transcript is the bulk and may go, but
  // the accounting is what `checkBudgetGate` reads for the daily cap.
  const removed: string[] = [];
  const now = Date.now();
  const files: Record<string, { size: number; mtimeMs: number }> = {
    "run.jsonl": { size: 10_000, mtimeMs: now },
    "run.acct.jsonl": { size: 10, mtimeMs: now },
    "index.jsonl": { size: 1, mtimeMs: 0 },
  };
  rotateSessions("/home", {
    maxBytes: 1,
    liveId: "other",
    now,
    listDir: () => Object.keys(files),
    statFn: (p) => files[p.split("/").pop() as string] as { size: number; mtimeMs: number },
    rmFn: (p) => removed.push(p.split("/").pop() as string),
    writeFn: () => {},
  });
  assert.deepEqual(removed, ["run.jsonl"]);
});

test("deleteSession removes the ACCOUNTING file too — it used to survive an explicit delete", () => {
  // It kept ranking in `latestAccountingSession`, so `prometheus tokens report` could still
  // report a session the user had deleted.
  const home = mkdtempSync(join(tmpdir(), "prom-del-"));
  try {
    recordSession(home, { id: "doomed", ts: "2026-01-01T00:00:00Z", descriptor: "d", cwd: "/w" });
    appendTurnEvents(home, "doomed", [{ role: "user", text: "x" }]);
    appendAccounting(home, "doomed", {
      atIso: "2026-01-01T00:00:00Z",
      model: "m",
      promptTokens: 1,
      completionTokens: 1,
      estimated: false,
    } as AccountingRecord);
    assert.equal(readAccounting(home, "doomed").length, 1, "fixture did not write accounting");
    deleteSession(home, "doomed");
    assert.deepEqual(readAccounting(home, "doomed"), [], "the accounting outlived the delete");
    assert.deepEqual(loadTurns(home, "doomed"), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("deleteSession rewrites the index ATOMICALLY and under the lock", async () => {
  /**
   * The index rewrite is the THIRD read-modify-write of index.jsonl, and it took neither of the
   * protections the other two take: `claimIndexLock`'s own doc named only `updateSessionSummary`
   * and `pruneIndex`. It also used a plain `writeFileSync`, which TRUNCATES before writing — a
   * crash in that window leaves a truncated index and every session before the cut is gone
   * from `/recall`.
   */
  const { mkdtempSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "prom-hs-del-"));

  for (const id of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) {
    recordSession(home, {
      id,
      ts: `2026-01-0${id[0] === "a" ? 1 : id[0] === "b" ? 2 : 3}T00:00:00Z`,
      descriptor: id,
      cwd: "/w",
    });
  }
  assert.equal(listSessions(home).length, 3);

  assert.equal(deleteSession(home, "bbbbbbbb"), true);
  const left = listSessions(home)
    .map((r) => r.id)
    .sort();
  assert.deepEqual(left, ["aaaaaaaa", "cccccccc"], "only the named session is pruned");

  // the index is still well-formed JSONL (an atomic replace, never a partial truncate)
  const raw = readFileSync(join(home, "sessions", "index.jsonl"), "utf8");
  for (const line of raw.split("\n").filter((l) => l.trim())) JSON.parse(line);

  // the lock is RELEASED — a leaked lock would make every later rewrite skip silently
  assert.equal(
    existsSync(join(home, "sessions", "index.jsonl.lock")),
    false,
    "deleteSession must not leak the index lock",
  );

  // deleting the last record leaves a valid (empty) index rather than a corrupt one
  deleteSession(home, "aaaaaaaa");
  deleteSession(home, "cccccccc");
  assert.deepEqual(listSessions(home), []);
});
