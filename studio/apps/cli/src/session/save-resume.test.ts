/**
 * save-resume.test.ts — `/save` and `/resume`, which said they worked and did not.
 *
 * `/save out.txt` printed `saving → out.txt…` and wrote nothing. That is the worst shape a bug
 * can take: a silent failure tells you something is wrong, while this one told the user it had
 * succeeded. The existing test for it asserted only that the slash parsed to a control —
 * `slash-exec.test.ts` still does — so the suite was green the whole time.
 *
 * `/resume` was an alias of `/recall`, which in the readline host printed a session's metadata
 * and then admitted, in dim text, that replay was "a follow-up". Underneath that, the readline
 * host never wrote turn CONTENT to disk at all, so there was nothing to replay from: it recorded
 * only the index entry (id, timestamp, first fifteen words, cwd).
 *
 * These tests are deliberately about the CONSEQUENCE — a file exists on disk, a thread comes
 * back — rather than about which function was called. A test that asserts "the arm ran" is what
 * let this ship.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { rebuildThread } from "./agent-runtime.js";
import { appendTurnEvents, listSessions, loadTurns, recordSession } from "./history-store.js";

const home = (): string => mkdtempSync(join(tmpdir(), "prom-saveres-"));

/* ── the persistence that was missing ──────────────────────────────────────*/

test("a turn's CONTENT round-trips to disk and back into a thread", () => {
  // The readline host recorded only the index entry, so `/recall` could list a session and
  // never restore it. This is the round trip that was absent.
  const h = home();
  recordSession(h, { id: "s1", ts: "2026-01-01T00:00:00Z", descriptor: "add retry", cwd: "/w" });
  appendTurnEvents(h, "s1", [
    { role: "user", text: "add retry to the client" },
    { kind: "text", text: "Added exponential backoff." },
  ]);

  const turns = loadTurns(h, "s1");
  assert.ok(turns.length >= 2, "the transcript did not reach disk");
  const { messages } = rebuildThread(turns);
  assert.ok(messages.length >= 2);
  assert.equal(messages[0]?.role, "user");
  assert.match(String(messages[0]?.content), /add retry to the client/);
});

test("listing a session and loading its turns are INDEPENDENT — the bug lived in the gap", () => {
  // `recordSession` alone makes a session appear in the picker. If nothing ever calls
  // `appendTurnEvents`, the picker is fully populated and every restore is empty — which is
  // precisely what the readline host did.
  const h = home();
  recordSession(h, { id: "ghost", ts: "2026-01-01T00:00:00Z", descriptor: "x", cwd: "/w" });
  assert.equal(listSessions(h).length, 1, "the session is listed");
  assert.deepEqual(loadTurns(h, "ghost"), [], "…and has no transcript behind it");
});

/* ── the wiring, asserted where it actually broke ──────────────────────────*/

/**
 * The five tests that used to live here asserted REGEXES OVER THIS REPO'S OWN SOURCE TEXT —
 * `assert.match(src("./host.ts"), /rebuildThread\(loadTurns\(home/)` and four like it.
 *
 * That guards a spelling, not a behaviour, and it fails in both directions. It broke when one
 * call was split into two statements while the feature worked perfectly; and, far worse, every
 * one of them would keep passing if the code they matched were unreachable, misordered, or
 * wrong — which is precisely the defect class this file was written to catch.
 *
 * They are replaced by consequence tests in `host.test.ts`, which drive the real host through
 * the real readline harness and assert that a file appears on disk, that a transcript is
 * persisted, and that a failed restore leaves the live conversation alone:
 *
 *   - "/save writes a real file to disk"
 *   - "a turn's content reaches the session store, so /recall has something to restore"
 *   - "resuming a session with NO transcript leaves the live conversation alone"
 *   - "the readline host hands runMessageTurn an abort signal"
 *   - "/continue is interruptible too — a continuation is a full turn"
 *
 * The two round-trip tests above stay: they exercise the store directly, which is behaviour.
 */
