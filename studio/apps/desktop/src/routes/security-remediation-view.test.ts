/**
 * security-remediation-view.test.ts — the remediation progress feed + purge-request
 * chain (APP-010). Pins the strict runId isolation, partial-chunk buffering, the
 * RUN_ID-safe correlation id, and the byte-exact typedName forwarding.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { purgeNameMatches as corePurgeNameMatches } from "@prometheus/core";
import {
  EMPTY_REMEDIATION_FEED,
  REMEDIATION_LOG_CAP,
  buildPurgeRequest,
  flushRemediationFeed,
  forwardPurge,
  mintRemediationRunId,
  purgeRequestIfConfirmed,
  reduceRemediationFeed,
} from "./security-remediation-view.js";

test("reduceRemediationFeed: strict runId filter keeps foreign/global ops out (deliverable 3)", () => {
  const s0 = EMPTY_REMEDIATION_FEED;
  const s1 = reduceRemediationFeed(s0, { runId: "mine", raw: "step 1\n" }, "mine");
  assert.deepEqual(s1.lines, ["step 1"]);
  // a foreign run's line is ignored (returns the SAME state reference — no churn).
  assert.equal(reduceRemediationFeed(s1, { runId: "other", raw: "noise\n" }, "mine"), s1);
  // a run-less global line (sidecar boot) is ignored.
  assert.equal(reduceRemediationFeed(s1, { raw: "global\n" }, "mine"), s1);
  // no active run armed ⇒ everything ignored.
  assert.equal(reduceRemediationFeed(s1, { runId: "mine", raw: "x\n" }, null), s1);
  // a null/undefined event is a no-op.
  assert.equal(reduceRemediationFeed(s1, null, "mine"), s1);
});

test("reduceRemediationFeed: strips ANSI SGR colour escapes before display", () => {
  const colored = "\x1b[31mDANGER\x1b[0m found\n";
  const s = reduceRemediationFeed(EMPTY_REMEDIATION_FEED, { runId: "r", raw: colored }, "r");
  assert.deepEqual(s.lines, ["DANGER found"]);
});

test("reduceRemediationFeed: an ANSI escape SPLIT across two stderr chunks is fully stripped", () => {
  // Buffer holds the RAW partial, so the escape re-joins before stripping — a
  // per-chunk strip would leave "1mDANGER" behind (the reviewer's nit).
  const p1 = reduceRemediationFeed(EMPTY_REMEDIATION_FEED, { runId: "r", raw: "\x1b[3" }, "r");
  assert.deepEqual(p1.lines, []); // incomplete escape, nothing emitted yet
  const p2 = reduceRemediationFeed(p1, { runId: "r", raw: "1mDANGER\x1b[0m\n" }, "r");
  assert.deepEqual(p2.lines, ["DANGER"]);
});

test("reduceRemediationFeed: buffers partial chunks on \\n; emits only whole lines", () => {
  // A chunk WITHOUT a newline stays fully buffered — nothing rendered yet.
  const p1 = reduceRemediationFeed(EMPTY_REMEDIATION_FEED, { runId: "r", raw: "scanning " }, "r");
  assert.deepEqual(p1.lines, []);
  assert.equal(p1.buffer, "scanning ");
  // The completing chunk flushes the joined line and re-buffers the new remainder.
  const p2 = reduceRemediationFeed(p1, { runId: "r", raw: "done\nnext" }, "r");
  assert.deepEqual(p2.lines, ["scanning done"]);
  assert.equal(p2.buffer, "next");
});

test("reduceRemediationFeed: multi-line payloads split; blank lines dropped; newest capped", () => {
  const multi = reduceRemediationFeed(
    EMPTY_REMEDIATION_FEED,
    { runId: "r", raw: "a\nb\n\nc\n" },
    "r",
  );
  assert.deepEqual(multi.lines, ["a", "b", "c"]);
  const many = {
    lines: Array.from({ length: REMEDIATION_LOG_CAP + 10 }, (_, i) => `l${i}`),
    buffer: "",
  };
  const capped = reduceRemediationFeed(many, { runId: "r", raw: "tail\n" }, "r");
  assert.equal(capped.lines.length, REMEDIATION_LOG_CAP);
  assert.equal(capped.lines[capped.lines.length - 1], "tail");
});

test("flushRemediationFeed: emits the trailing buffered line so the summary is never lost", () => {
  const pending = { lines: ["phase 1"], buffer: "cleaned 3 findings" }; // no trailing \n
  const flushed = flushRemediationFeed(pending);
  assert.deepEqual(flushed.lines, ["phase 1", "cleaned 3 findings"]);
  assert.equal(flushed.buffer, "");
  // an already-empty buffer flushes to a no-op (same reference).
  const idle = { lines: ["x"], buffer: "" };
  assert.equal(flushRemediationFeed(idle), idle);
  // a whitespace-only buffer clears without adding a blank line.
  assert.deepEqual(flushRemediationFeed({ lines: ["x"], buffer: "  \r" }).lines, ["x"]);
});

test("mintRemediationRunId: always matches main's RUN_ID regex, ≤128, non-empty, distinct", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 8; i += 1) {
    const id = mintRemediationRunId();
    assert.match(id, /^[A-Za-z0-9._:-]+$/);
    assert.ok(id.length >= 1 && id.length <= 128);
    ids.add(id);
  }
  assert.ok(ids.size > 1, "successive ids should differ");
});

test("buildPurgeRequest: forwards the typed basename VERBATIM as typedName (deliverable 4)", () => {
  const req = buildPurgeRequest({ path: "vault/agent.py" }, "agent.py", "run-9");
  assert.deepEqual(req, {
    op: "purge",
    target: "vault/agent.py",
    kind: "quarantine",
    typedName: "agent.py",
    runId: "run-9",
  });
  // runId is optional — omitted when not supplied (no undefined key on the wire).
  assert.deepEqual(buildPurgeRequest({ path: "a/b.txt" }, "b.txt"), {
    op: "purge",
    target: "a/b.txt",
    kind: "quarantine",
    typedName: "b.txt",
  });
  // The typed string is passed byte-exact — NFD vs NFC is preserved (main compares
  // === against purgeBasename, so a normalized echo would be REFUSED, not coerced).
  const nfd = "résumé.pdf"; // e + combining acute
  assert.equal(buildPurgeRequest({ path: `v/${nfd}` }, nfd).typedName, nfd);
});

test("purgeRequestIfConfirmed: exact basename => request; any mismatch => null (no call)", () => {
  const item = { path: "vault/agent.py" };
  assert.deepEqual(purgeRequestIfConfirmed(item, "agent.py", "run-1"), {
    op: "purge",
    target: "vault/agent.py",
    kind: "quarantine",
    typedName: "agent.py",
    runId: "run-1",
  });
  assert.equal(purgeRequestIfConfirmed(item, "vault/agent.py"), null); // full path, not basename
  assert.equal(purgeRequestIfConfirmed(item, "Agent.py"), null); // case-fold rejected
  assert.equal(purgeRequestIfConfirmed(item, ""), null); // empty rejected
});

test("purgeRequestIfConfirmed: the replicated basename gate AGREES with @prometheus/core (no drift)", () => {
  const cases: Array<[string, string]> = [
    ["agent.py", "server/agent.py"],
    ["server/agent.py", "server/agent.py"],
    ["Agent.py", "server/agent.py"],
    ["m.bin", "x.zip!m.bin"],
    ["b.txt", "a\\b.txt"],
    ["", ""],
    ["dir", "dir/"],
  ];
  for (const [typed, path] of cases) {
    const routeAllows = purgeRequestIfConfirmed({ path }, typed) !== null;
    assert.equal(
      routeAllows,
      corePurgeNameMatches(typed, path),
      `drift for ${JSON.stringify(typed)} / ${JSON.stringify(path)}`,
    );
  }
});

test("forwardPurge: wrong typed name => remediate NEVER called (§9.3 zero-call contract, deliverable 4)", async () => {
  let calls = 0;
  let lastReq: unknown = null;
  const spy = async (req: unknown) => {
    calls += 1;
    lastReq = req;
    return { ok: true as const, op: "purge" as const, data: { engineRemoved: true } };
  };
  const item = { path: "vault/agent.py" };

  // wrong name (the full path) — the destroy path's exact zero-call contract.
  const wrong = await forwardPurge(spy, item, "vault/agent.py");
  assert.equal(calls, 0, "remediate must NOT be called on a name mismatch");
  assert.equal(wrong.called, false);

  // case-fold mismatch — still refused, still zero calls.
  await forwardPurge(spy, item, "Agent.py");
  assert.equal(calls, 0);

  // a NFD echo of a NFC basename is a different byte string ⇒ refused (no coercion).
  const nfc = "résumé.pdf".normalize("NFC");
  const nfd = "résumé.pdf".normalize("NFD");
  await forwardPurge(spy, { path: `vault/${nfc}` }, nfd);
  assert.equal(calls, 0, "cross-normalization echo must NOT call remediate");

  // exact basename ⇒ exactly one call carrying typedName VERBATIM.
  const ok = await forwardPurge(spy, item, "agent.py", "run-1");
  assert.equal(calls, 1, "the exact basename makes exactly one remediate call");
  assert.equal(ok.called, true);
  assert.deepEqual(lastReq, {
    op: "purge",
    target: "vault/agent.py",
    kind: "quarantine",
    typedName: "agent.py",
    runId: "run-1",
  });
});
